import { randomUUID } from 'node:crypto';
import { AppError } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { VaultService } from './vault.js';

/** Secret-Metadaten anlegen (Wert folgt über `setSecretValue`). Gleiche Struktur wie `POST …/secrets`. */
export function createSecretRow(
  ctx: AppContext,
  o: { projectId: string; name: string; environment: string; description: string | null; userId: string },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ctx.db.run(
    `INSERT INTO secrets (id, project_id, name, description, kind, environment,
     vault_reference, version, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, 'env', ?, ?, 1, ?, ?, ?)`,
    id, o.projectId, o.name, o.description, o.environment, randomUUID(), now, now, o.userId,
  );
  ctx.db.run(
    `INSERT INTO secret_grants (id, secret_id, subject_type, subject_id, capability, created_at, created_by)
     VALUES (?, ?, 'user', ?, 'secret.update', ?, ?)`,
    randomUUID(), id, o.userId, now, o.userId,
  );
  return id;
}

/** Wert verschlüsselt im Vault ablegen und die Version erhöhen. */
export function setSecretValue(
  ctx: AppContext,
  o: { projectId: string; secretId: string; value: string },
): { version: number } {
  if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist auf diesem Server nicht initialisiert');
  const secret = ctx.db.get<{ name: string; environment: string; version: number }>(
    'SELECT name, environment, version FROM secrets WHERE id = ? AND project_id = ?',
    o.secretId, o.projectId,
  );
  if (!secret) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
  const version = secret.version + 1;
  const aad = VaultService.aad(o.projectId, secret.name, secret.environment, version);
  const reference = ctx.vault.put(o.value, aad, o.secretId);
  ctx.db.run(
    'UPDATE secrets SET vault_reference = ?, version = ?, updated_at = ? WHERE id = ?',
    reference, version, new Date().toISOString(), o.secretId,
  );
  return { version };
}
