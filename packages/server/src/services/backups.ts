import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { audit } from './audit.js';

/** Bundle-Format (Entscheidung A11): Verzeichnis mit manifest.json + Dateien + SHA-256. */
export const BACKUP_FORMAT = 1;
const MANIFEST = 'backup_manifest.json';

export interface BackupRow {
  id: string;
  kind: string;
  target_path: string;
  manifest_path: string | null;
  status: 'running' | 'success' | 'failed';
  created_at: string;
  finished_at: string | null;
  verified_at: string | null;
  size_bytes: number | null;
  checksum: string | null;
  created_by: string | null;
  error: string | null;
}

export interface BackupManifest {
  format: number;
  id: string;
  kind: 'system';
  created_at: string;
  schema_version: number;
  vault_key_id: string | null;
  items: Array<{ path: string; sha256: string; bytes: number }>;
}

interface Actor {
  id: string | null;
  label: string;
  type: 'user' | 'system';
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function bundleName(createdAt: string): string {
  return `devdeck-${createdAt.replace(/[:.]/g, '-')}`;
}

/** Nicht-geheime Konfiguration (ohne Bootstrap-Zugangsdaten). */
function safeConfigSnapshot(ctx: AppContext): string {
  const c = ctx.config;
  return JSON.stringify(
    {
      host: c.host,
      port: c.port,
      sessionTtlMs: c.sessionTtlMs,
      secureCookies: c.secureCookies,
      trustProxy: c.trustProxy,
      backupIntervalHours: c.backupIntervalHours,
      backupRetentionDaily: c.backupRetentionDaily,
      backupRetentionWeekly: c.backupRetentionWeekly,
    },
    null,
    2,
  );
}

/**
 * System-Backup: konsistente Snapshots von devdeck.db und vault.db (verschlüsselte Blobs).
 * Der Vault-Key wird bewusst NICHT gesichert – er muss separat verwahrt werden.
 */
export function createSystemBackup(ctx: AppContext, actor: Actor): BackupRow {
  const { db, config, vault } = ctx;
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const dir = path.join(config.backupTarget, bundleName(createdAt));
  db.run(
    `INSERT INTO backups (id, kind, target_path, status, created_at, created_by)
     VALUES (?, 'system', ?, 'running', ?, ?)`,
    id,
    dir,
    createdAt,
    actor.id,
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    db.snapshotTo(path.join(dir, 'devdeck.db'));
    if (vault) vault.snapshotTo(path.join(dir, 'vault.db'));
    fs.writeFileSync(path.join(dir, 'config.json'), safeConfigSnapshot(ctx), { mode: 0o600 });

    const items = fs
      .readdirSync(dir)
      .filter((f) => f !== MANIFEST)
      .sort()
      .map((f) => {
        const full = path.join(dir, f);
        return { path: f, sha256: sha256File(full), bytes: fs.statSync(full).size };
      });
    const version = db.get<{ user_version: number }>('PRAGMA user_version');
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      id,
      kind: 'system',
      created_at: createdAt,
      schema_version: version?.user_version ?? 0,
      vault_key_id: vault?.keyId ?? null,
      items,
    };
    const manifestPath = path.join(dir, MANIFEST);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const total = items.reduce((n, i) => n + i.bytes, 0);
    db.transaction(() => {
      for (const item of items) {
        db.run(
          'INSERT INTO backup_items (backup_id, relative_path, sha256, bytes) VALUES (?, ?, ?, ?)',
          id,
          item.path,
          item.sha256,
          item.bytes,
        );
      }
      db.run(
        `UPDATE backups SET status = 'success', finished_at = ?, size_bytes = ?, manifest_path = ?, checksum = ?
         WHERE id = ?`,
        new Date().toISOString(),
        total,
        manifestPath,
        sha256File(manifestPath),
        id,
      );
    });
    audit(db, {
      actor_type: actor.type,
      actor_id: actor.id,
      actor_label: actor.label,
      action: 'backup.create',
      target_type: 'backup',
      target_id: id,
      result: 'success',
      detail: { path: dir, bytes: total },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.run(
      `UPDATE backups SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      new Date().toISOString(),
      message,
      id,
    );
    audit(db, {
      actor_type: actor.type,
      actor_id: actor.id,
      actor_label: actor.label,
      action: 'backup.create',
      target_type: 'backup',
      target_id: id,
      result: 'failure',
      detail: { error: message },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return getBackup(ctx, id)!;
}

export function listBackups(ctx: AppContext): BackupRow[] {
  return ctx.db.all<BackupRow>('SELECT * FROM backups ORDER BY created_at DESC');
}

export function getBackup(ctx: AppContext, id: string): BackupRow | undefined {
  return ctx.db.get<BackupRow>('SELECT * FROM backups WHERE id = ?', id);
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

/** Prüft ein Bundle im Dateisystem anhand seines Manifests (unabhängig von der DB). */
export function verifyBundle(dir: string): VerifyResult {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as BackupManifest;
  } catch {
    return { ok: false, problems: ['Manifest fehlt oder ist nicht lesbar'] };
  }
  if (manifest.format !== BACKUP_FORMAT) problems.push(`Unbekanntes Format ${manifest.format}`);
  for (const item of manifest.items ?? []) {
    const rel = path.normalize(item.path);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      problems.push(`Unzulässiger Pfad im Manifest: ${item.path}`);
      continue;
    }
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) {
      problems.push(`Fehlt: ${item.path}`);
    } else if (sha256File(full) !== item.sha256) {
      problems.push(`Prüfsumme stimmt nicht: ${item.path}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function verifyBackup(ctx: AppContext, id: string, actor: Actor): VerifyResult {
  const row = getBackup(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', 'Backup nicht gefunden');
  if (row.status !== 'success') throw new AppError('CONFLICT', 'Nur erfolgreiche Backups lassen sich prüfen');
  const result = verifyBundle(row.target_path);
  if (result.ok) {
    ctx.db.run('UPDATE backups SET verified_at = ? WHERE id = ?', new Date().toISOString(), id);
  }
  audit(ctx.db, {
    actor_type: actor.type,
    actor_id: actor.id,
    actor_label: actor.label,
    action: 'backup.verify',
    target_type: 'backup',
    target_id: id,
    result: result.ok ? 'success' : 'failure',
    detail: { problems: result.problems },
  });
  return result;
}

function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/**
 * Retention: pro Kalendertag das neueste Backup der letzten `daily` Tage und pro
 * ISO-Woche das neueste der letzten `weekly` Wochen behalten; Rest löschen.
 * Fehlgeschlagene Backups werden aufgeräumt.
 */
export function applyRetention(ctx: AppContext): { deleted: string[] } {
  const { daily, weekly } = {
    daily: ctx.config.backupRetentionDaily,
    weekly: ctx.config.backupRetentionWeekly,
  };
  const rows = listBackups(ctx);
  const ok = rows.filter((r) => r.status === 'success'); // neueste zuerst
  const keep = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const r of ok) {
    const day = r.created_at.slice(0, 10);
    if (!days.has(day) && days.size < daily) {
      days.add(day);
      keep.add(r.id);
    }
  }
  for (const r of ok) {
    const week = isoWeekKey(new Date(r.created_at));
    if (!weeks.has(week) && weeks.size < weekly) {
      weeks.add(week);
      keep.add(r.id);
    }
  }
  const deleted: string[] = [];
  for (const r of rows) {
    if (r.status === 'running') continue;
    if (r.status === 'success' && keep.has(r.id)) continue;
    // Nur Pfade innerhalb des Backup-Ziels löschen
    const rel = path.relative(ctx.config.backupTarget, r.target_path);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      fs.rmSync(r.target_path, { recursive: true, force: true });
    }
    ctx.db.run('DELETE FROM backups WHERE id = ?', r.id);
    deleted.push(r.id);
  }
  if (deleted.length > 0) {
    audit(ctx.db, {
      actor_type: 'system',
      actor_label: 'retention',
      action: 'backup.retention',
      result: 'success',
      detail: { deleted: deleted.length },
    });
  }
  return { deleted };
}

/** Scheduler-Tick: Backup erstellen, wenn das letzte erfolgreiche älter als das Intervall ist. */
export function runScheduledBackup(ctx: AppContext, now = Date.now()): BackupRow | null {
  const hours = ctx.config.backupIntervalHours;
  if (!(hours > 0)) return null;
  const last = ctx.db.get<{ created_at: string }>(
    `SELECT created_at FROM backups WHERE status IN ('success','running') ORDER BY created_at DESC LIMIT 1`,
  );
  if (last && now - Date.parse(last.created_at) < hours * 3_600_000) return null;
  const row = createSystemBackup(ctx, { id: null, label: 'scheduler', type: 'system' });
  if (row.status === 'success') applyRetention(ctx);
  return row;
}
