import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Zentrale Server-Konfiguration (Env-getrieben, testschonbar). */
export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  vaultDir: string;
  vaultKeyPath: string;
  backupTarget: string;
  /** 0 = Scheduler aus. */
  backupIntervalHours: number;
  backupRetentionDaily: number;
  backupRetentionWeekly: number;
  webuiDir: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  trustProxy: boolean;
  bootstrapAdminEmail: string | null;
  bootstrapAdminPassword: string | null;
}

export type Env = Record<string, string | undefined>;

/** WebUI-Ordner finden: dist/webui (nach Build) oder src/webui (Development). */
function resolveWebuiDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, 'webui'),
    path.resolve(moduleDir, '..', 'src', 'webui'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return candidates[0]!;
}

export function loadConfig(env: Env = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = path.resolve(overrides.dataDir ?? env.DEVDECK_DATA_DIR ?? './data');
  const config: ServerConfig = {
    host: env.DEVDECK_HOST ?? '127.0.0.1',
    port: Number(env.DEVDECK_PORT ?? 8080),
    dataDir,
    dbPath: path.join(dataDir, 'devdeck.db'),
    vaultDir: path.join(dataDir, 'vault'),
    vaultKeyPath: path.join(dataDir, 'vault', 'vault.key'),
    backupTarget: path.resolve(env.DEVDECK_BACKUP_TARGET ?? env.DEVDECK_BACKUP_DIR ?? path.join(dataDir, 'backups')),
    backupIntervalHours: Number(env.DEVDECK_BACKUP_INTERVAL_HOURS ?? 24),
    backupRetentionDaily: Number(env.DEVDECK_BACKUP_RETENTION_DAILY ?? 7),
    backupRetentionWeekly: Number(env.DEVDECK_BACKUP_RETENTION_WEEKLY ?? 4),
    webuiDir: path.resolve(env.DEVDECK_WEBUI_DIR ?? resolveWebuiDir()),
    sessionTtlMs: Number(env.DEVDECK_SESSION_TTL_DAYS ?? 14) * 24 * 60 * 60 * 1000,
    secureCookies: env.DEVDECK_SECURE_COOKIES === '1',
    trustProxy: env.DEVDECK_TRUST_PROXY === '1',
    bootstrapAdminEmail: env.DEVDECK_ADMIN_EMAIL ?? null,
    bootstrapAdminPassword: env.DEVDECK_ADMIN_PASSWORD ?? null,
    ...overrides,
  };
  return config;
}
