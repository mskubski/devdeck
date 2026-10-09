import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { loadConfig, type Env, type ServerConfig } from './config.js';
import { Database } from './db/database.js';
import { migrate, SCHEMA_VERSION } from './db/schema.js';
import { createApp } from './app.js';
import type { AppContext } from './context.js';
import { hashPassword } from './auth/passwords.js';
import { audit } from './services/audit.js';
import { sweepExpiredCommands, sweepOfflineAgents } from './services/provisioning.js';
import type { UserRecord } from './auth/middleware.js';
import { VaultService } from './vault/vault.js';

export interface RunningServer {
  app: ReturnType<typeof createApp>;
  ctx: AppContext;
  db: Database;
  server: Server;
  close(): Promise<void>;
}

/** Erstellt beim allerersten Start einen Admin aus Env (niemals Default-Passwort). */
export function bootstrapAdmin(ctx: AppContext): UserRecord | null {
  const { db, config } = ctx;
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  if ((count?.n ?? 0) > 0) return null;
  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    console.warn(
      '[DevDeck] Keine Benutzer vorhanden. Lege den initialen Admin an, indem ' +
        'DEVDECK_ADMIN_EMAIL und DEVDECK_ADMIN_PASSWORD gesetzt sind.',
    );
    return null;
  }
  const now = new Date().toISOString();
  const user: UserRecord = {
    id: randomUUID(),
    email: config.bootstrapAdminEmail.trim().toLowerCase(),
    password_hash: hashPassword(config.bootstrapAdminPassword),
    system_role: 'admin',
    display_name: 'Administrator',
    created_at: now,
    updated_at: now,
    disabled: 0,
  };
  db.run(
    `INSERT INTO users (id, email, password_hash, system_role, display_name, created_at, updated_at, disabled)
     VALUES (?, ?, ?, 'admin', ?, ?, ?, 0)`,
    user.id,
    user.email,
    user.password_hash,
    user.display_name,
    user.created_at,
    user.updated_at,
  );
  audit(db, {
    actor_type: 'system',
    actor_label: 'bootstrap',
    action: 'user.bootstrap_admin',
    target_type: 'user',
    target_id: user.id,
    result: 'success',
    detail: { email: user.email },
  });
  console.warn(`[DevDeck] Initialer Admin angelegt: ${user.email}`);
  return user;
}

/** Anwendungskontext + DB aufbauen (ohne listen – für Tests und Start). */
export function createServerContext(
  env: Env = process.env,
  overrides: Partial<ServerConfig> = {},
): AppContext {
  const config = loadConfig(env, overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.vaultKeyPath), { recursive: true });
  fs.mkdirSync(config.backupTarget, { recursive: true });
  const db = new Database(config.dbPath);
  migrate(db);
  const vault = new VaultService(config.vaultKeyPath, env.DEVDECK_VAULT_KEY ?? null);
  const ctx: AppContext = { db, config, vault };
  if (vault.keyCreated) {
    audit(db, {
      actor_type: 'system',
      actor_label: 'bootstrap',
      action: 'vault.key.create',
      result: 'success',
      detail: { key_id: vault.keyId, path: config.vaultKeyPath },
    });
    console.warn(
      `[DevDeck] Neuer Vault-Key erzeugt unter ${config.vaultKeyPath} (0600). ` +
        'Dieser Key ist unersetzlich – ohne ihn sind gespeicherte Secrets verloren. Sichern!',
    );
  }
  bootstrapAdmin(ctx);
  return ctx;
}

/** Server starten (Deploy-Betrieb). */
export async function startServer(
  env: Env = process.env,
  overrides: Partial<ServerConfig> = {},
): Promise<RunningServer> {
  const ctx = createServerContext(env, overrides);
  const app = createApp(ctx);
  const { host, port } = ctx.config;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  // Hintergrund-Sweeper: offline-Maschinen + abgelaufene Commands
  const sweeper = setInterval(() => {
    try {
      sweepOfflineAgents(ctx.db);
      sweepExpiredCommands(ctx.db);
    } catch {
      /* Fehler nie den Betrieb stoppen */
    }
  }, 60_000);
  sweeper.unref();
  console.warn(`[DevDeck] Server läuft auf http://${host}:${port} (Schema v${SCHEMA_VERSION})`);
  return {
    app,
    ctx,
    db: ctx.db,
    server,
    close: async () => {
      clearInterval(sweeper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ctx.vault?.close();
      ctx.db.close();
    },
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServer().catch((err) => {
    console.error('[DevDeck] Startfehler:', err);
    process.exit(1);
  });
}
