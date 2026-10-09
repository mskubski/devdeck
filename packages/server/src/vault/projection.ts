import type { Database } from '../db/database.js';
import type { VaultService } from './vault.js';
import { getProjectMembership, secretCapabilitiesFor } from '../auth/middleware.js';
import type { ProjectRole } from '@devdeck/shared';

/**
 * `.env`-Projektion + Secret-File-Entschlüsselung für den Agenten (PLAN §4, Phase G).
 * Gibt ausschließlich Werte zurück, für die `userId` (der Maschinen-Besitzer) über
 * seine effektive Projektrolle + Grants die passende Capability besitzt.
 * Secret-Werte laufen NIE durchs Audit-Log – nur Zähler/Metadaten.
 */
export interface ProjectedSecrets {
  env: Record<string, string>;
  files: Array<{ target_path: string; content_base64: string }>;
}

interface SecretRow {
  id: string;
  name: string;
  kind: 'env' | 'file';
  vault_reference: string;
  version: number;
}

interface TargetRow {
  target_path: string;
  file_mode: string;
}

function effectiveRole(
  db: Database,
  projectId: string,
  userId: string,
  isSystemAdmin: boolean,
): ProjectRole | null {
  return getProjectMembership(db, projectId, userId) ?? (isSystemAdmin ? 'owner' : null);
}

/** Autorisierte Secrets eines Projekts/Environments für den Maschinenbesitzer projizieren. */
export function projectSecretsFor(
  db: Database,
  vault: VaultService,
  projectId: string,
  ownerUserId: string,
  ownerIsAdmin: boolean,
  environment: string,
): ProjectedSecrets {
  const result: ProjectedSecrets = { env: {}, files: [] };
  const role = effectiveRole(db, projectId, ownerUserId, ownerIsAdmin);
  if (!role) return result;

  const secrets = db.all<SecretRow>(
    `SELECT id, name, kind, vault_reference, version FROM secrets
     WHERE project_id = ? AND environment = ?`,
    projectId,
    environment,
  );

  for (const secret of secrets) {
    const caps = secretCapabilitiesFor(db, secret.id, ownerUserId, role);
    if (secret.kind === 'env') {
      if (!caps.has('secret.use')) continue;
      if (!vault.has(secret.vault_reference)) continue;
      result.env[secret.name] = vault.getString(secret.vault_reference);
    } else if (secret.kind === 'file') {
      if (!caps.has('secret.file.deploy')) continue;
      if (!vault.has(secret.vault_reference)) continue;
      const content = vault.getString(secret.vault_reference);
      const targets = db.all<TargetRow>(
        'SELECT target_path, file_mode FROM secret_targets WHERE secret_id = ?',
        secret.id,
      );
      for (const target of targets) {
        result.files.push({
          target_path: target.target_path,
          content_base64: Buffer.from(content, 'utf8').toString('base64'),
        });
      }
    }
  }
  return result;
}

/** Nur Metadaten (Name + Version) – für `secrets.check`, ohne zu entschlüsseln. */
export function secretVersionsFor(
  db: Database,
  projectId: string,
  environment: string,
): Array<{ name: string; kind: string; version: number }> {
  return db.all<{ name: string; kind: string; version: number }>(
    `SELECT name, kind, version FROM secrets WHERE project_id = ? AND environment = ?
     ORDER BY name`,
    projectId,
    environment,
  );
}
