import fs from 'node:fs';
import path from 'node:path';
import {
  AppError,
  normalizeBackupRetention,
  normalizeBackupSources,
  type BackupBundleInfo,
} from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { collectFacts } from '../facts.js';
import { scanBundles, verifyBundleDir } from '../backup/bundle.js';
import { safeJoin } from '../backup/fsutil.js';
import { checkTargetDir, claimJob, releaseJob, Reporter, runBackupJob } from '../backup/run.js';
import { runRestoreJob } from '../backup/restore.js';
import { log } from '../logger.js';

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v === '') throw new AppError('VALIDATION', `${field} ist erforderlich`);
  return v;
};

/** Ordner, die typischerweise Nutzdaten enthalten (Uploads, Medien, …). */
const DATA_DIRS = ['uploads', 'upload', 'storage', 'media', 'files', 'attachments', 'data', 'public/uploads', 'static/uploads'];
const SECRET_FILE = /^(\.env(\..*)?|.*\.key|agent\.json|.*\.pem)$/i;
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__']);

/** Größe/Dateizahl begrenzt zählen und prüfen, ob der Ordner Zugangsdaten enthält. */
function inspectDir(dir: string): { bytes: number; files: number; truncated: boolean; hasSecrets: boolean } {
  let bytes = 0;
  let files = 0;
  let hasSecrets = false;
  let truncated = false;
  const walk = (current: string, depth: number): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && depth < 8) walk(path.join(current, e.name), depth + 1);
      } else if (e.isFile()) {
        if (depth <= 2 && SECRET_FILE.test(e.name)) hasSecrets = true;
        files += 1;
        try {
          bytes += fs.statSync(path.join(current, e.name)).size;
        } catch {
          /* Datei verschwunden */
        }
        if (files >= 50_000) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(dir, 0);
  return { bytes, files, truncated, hasSecrets };
}

/** Backup-Ordner in der Umgebung eines Workspaces (z. B. „peefinder-backups“ neben dem Projekt) mit erkennbaren Backups. */
function findBackupDirs(workspacePath: string): Array<{ path: string; bundles: number; newest: string | null }> {
  const out: Array<{ path: string; bundles: number; newest: string | null }> = [];
  for (const base of [workspacePath, path.dirname(workspacePath)]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/backup/i.test(e.name)) continue;
      const dir = path.join(base, e.name);
      const bundles = scanBundles(dir);
      if (bundles.length > 0) out.push({ path: dir, bundles: bundles.length, newest: bundles[0]!.created_at });
    }
  }
  return out;
}

/** backup.detect – was im Workspace sicherungswürdig ist (nur lesend). */
registerAction('backup.detect', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const dirs = DATA_DIRS.flatMap((rel) => {
    const full = path.join(workspacePath, ...rel.split('/'));
    try {
      if (!fs.statSync(full).isDirectory()) return [];
    } catch {
      return [];
    }
    const info = inspectDir(full);
    return info.files === 0 ? [] : [{ path: full, rel, ...info }];
  });
  const sqlite = collectFacts(workspacePath).databases.map((d) => ({ path: path.join(workspacePath, ...d.path.split('/')), bytes: d.bytes }));
  return { workspace: workspacePath, dirs, sqlite, backup_dirs: findBackupDirs(workspacePath) };
});

/** backup.scan – Backup-Ordner einlesen (vorhandene Backups erkennen), optional ein Backup prüfen; meldet das Ergebnis an den Server. */
registerAction('backup.scan', async (ctx) => {
  const jobId = str(ctx.payload.job_id, 'job_id');
  const targetDir = checkTargetDir(str(ctx.payload.target_dir, 'target_dir'));
  const bundles: BackupBundleInfo[] = scanBundles(targetDir);
  const verifyName = typeof ctx.payload.verify_bundle === 'string' ? ctx.payload.verify_bundle : null;
  if (verifyName) {
    const bundle = bundles.find((b) => b.name === verifyName);
    if (!bundle) throw new AppError('NOT_FOUND', `Backup ${verifyName} nicht gefunden`);
    bundle.verify = await verifyBundleDir(safeJoin(targetDir, verifyName));
  }
  const reporter = new Reporter(ctx.client, { job_id: jobId, kind: 'scan' });
  await reporter.send({ bundles });
  return { bundles: bundles.length, target_dir: targetDir };
});

/** backup.run – Backup im Hintergrund starten (blockiert die Auftragsschlange nicht); Fortschritt/Ergebnis kommen per Meldung. */
registerAction('backup.run', async (ctx) => {
  const jobId = str(ctx.payload.job_id, 'job_id');
  const runId = str(ctx.payload.run_id, 'run_id');
  const targetDir = str(ctx.payload.target_dir, 'target_dir');
  const sources = normalizeBackupSources(ctx.payload.sources);
  const retention = normalizeBackupRetention(ctx.payload.retention);
  claimJob(jobId);
  void runBackupJob({
    client: ctx.client, config: ctx.config, jobId, runId, targetDir, sources, retention,
    trigger: typeof ctx.payload.trigger === 'string' ? ctx.payload.trigger : 'manual',
  }).catch((err) => {
    releaseJob(jobId);
    log.error(`Backup-Lauf abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { started: true };
});

/** backup.restore – nur mit vom Server geprüfter Bestätigung; der Agent prüft den Bestätigungstext erneut. */
registerAction('backup.restore', async (ctx) => {
  const jobId = str(ctx.payload.job_id, 'job_id');
  const confirmation = (ctx.payload.confirmation ?? {}) as { phrase?: unknown; by?: unknown; at?: unknown };
  const options = {
    client: ctx.client,
    config: ctx.config,
    jobId,
    restoreId: str(ctx.payload.restore_id, 'restore_id'),
    safetyRunId: str(ctx.payload.safety_run_id, 'safety_run_id'),
    targetDir: str(ctx.payload.target_dir, 'target_dir'),
    bundleName: str(ctx.payload.bundle_name, 'bundle_name'),
    sources: normalizeBackupSources(ctx.payload.sources),
    retention: normalizeBackupRetention(ctx.payload.retention),
    sourceIds: Array.isArray(ctx.payload.source_ids) ? ctx.payload.source_ids.filter((x): x is string => typeof x === 'string') : [],
    confirmation: { phrase: String(confirmation.phrase ?? ''), by: String(confirmation.by ?? ''), at: String(confirmation.at ?? '') },
  };
  claimJob(jobId);
  void runRestoreJob(options).catch((err) => {
    releaseJob(jobId);
    log.error(`Restore abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { started: true };
});
