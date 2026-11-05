import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  RESTORE_CONFIRM_PHRASE,
  agentSupportsAction,
  isBackupDue,
  nextScheduledRun,
  normalizeBackupRetention,
  normalizeBackupSchedule,
  normalizeBackupSources,
  type BackupBundleInfo,
  type BackupReport,
  type BackupRetention,
  type BackupSchedule,
  type BackupSource,
} from '@devdeck/shared';
import type { AppContext } from '../context.js';
import type { MachineRecord } from '../auth/middleware.js';
import { audit } from './audit.js';
import { enqueueCommand } from './provisioning.js';
import { getReplica, replicaDto, requestReplicaSync } from './backupReplicas.js';

export interface JobRow {
  id: string;
  project_id: string;
  name: string;
  machine_id: string;
  target_dir: string;
  sources_json: string;
  schedule_json: string;
  retention_json: string;
  enabled: number;
  last_triggered_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupRow {
  id: string;
  job_id: string;
  project_id: string;
  bundle_name: string | null;
  status: string;
  trigger_kind: string;
  origin: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  size_bytes: number | null;
  summary_json: string | null;
  progress: string | null;
  error: string | null;
  verified_at: string | null;
  verify_json: string | null;
}

interface RestoreRow {
  id: string;
  job_id: string;
  bundle_name: string;
  status: string;
  requested_by: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  progress: string | null;
  summary_json: string | null;
  error: string | null;
}

interface Actor {
  id: string | null;
  label: string;
  type: 'user' | 'system';
}

const parse = <T>(v: string | null | undefined, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Pfadlogik der Ziel-Maschine (der Server kann ein anderes Betriebssystem haben als der Agent). */
const pathFor = (platform: string): typeof path.posix => (platform === 'win32' ? path.win32 : path.posix);

export function getJob(ctx: AppContext, projectId: string, jobId: string): JobRow {
  const job = ctx.db.get<JobRow>('SELECT * FROM backup_jobs WHERE id = ? AND project_id = ?', jobId, projectId);
  if (!job) throw new AppError('NOT_FOUND', 'Backup-Job nicht gefunden');
  return job;
}

function loadMachine(ctx: AppContext, machineId: string): MachineRecord {
  const m = ctx.db.get<MachineRecord>('SELECT * FROM machines WHERE id = ?', machineId);
  if (!m || m.revoked_at) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden oder widerrufen');
  return m;
}

/** Die Maschine muss online sein und ein Agent-Release mit Backup-Funktionen haben. */
function assertMachineReady(machine: MachineRecord, action: 'backup.run' | 'backup.scan' | 'backup.restore' | 'backup.detect', needOnline: boolean): void {
  if (!agentSupportsAction(machine.agent_version, action)) {
    throw new AppError(
      'VALIDATION',
      `Der Agent auf „${machine.name}“ (Version ${machine.agent_version ?? 'unbekannt'}) kennt die Backup-Funktionen noch nicht. ` +
        'Bitte zuerst aktualisieren: System → „Server aktualisieren“ (mit „Agents mit aktualisieren“) oder Maschinen → „Agent updaten“.',
    );
  }
  if (needOnline && machine.agent_status !== 'online') {
    throw new AppError('AGENT_OFFLINE', `Maschine „${machine.name}“ ist nicht online`);
  }
}

function validateTargetDir(machine: MachineRecord, dir: unknown): string {
  if (typeof dir !== 'string' || dir.trim() === '' || dir.length > 500) throw new AppError('VALIDATION', 'Backup-Ordner fehlt');
  const p = pathFor(machine.platform);
  if (!p.isAbsolute(dir)) throw new AppError('VALIDATION', `Der Backup-Ordner muss ein absoluter Pfad auf „${machine.name}“ sein`);
  const resolved = p.resolve(dir);
  if (p.dirname(resolved) === resolved) throw new AppError('VALIDATION', 'Das Wurzelverzeichnis ist als Backup-Ordner nicht zulässig');
  return resolved;
}

export interface JobInput {
  name?: unknown;
  machine_id?: unknown;
  target_dir?: unknown;
  sources?: unknown;
  schedule?: unknown;
  retention?: unknown;
  enabled?: unknown;
}

function jobName(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 120) throw new AppError('VALIDATION', 'Name fehlt oder ist zu lang');
  return v.trim();
}

export function createJob(ctx: AppContext, projectId: string, input: JobInput, actor: Actor): JobRow {
  const machine = loadMachine(ctx, String(input.machine_id ?? ''));
  const name = jobName(input.name ?? 'Standard');
  const sources = normalizeBackupSources(input.sources);
  const schedule = normalizeBackupSchedule(input.schedule);
  const retention = normalizeBackupRetention(input.retention);
  const targetDir = validateTargetDir(machine, input.target_dir);
  if (ctx.db.get('SELECT 1 FROM backup_jobs WHERE project_id = ? AND name = ?', projectId, name)) {
    throw new AppError('CONFLICT', 'Ein Job mit diesem Namen existiert bereits');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  // Ein neuer Job löst nicht sofort einen geplanten Lauf aus: der Zeitplan beginnt jetzt.
  ctx.db.run(
    `INSERT INTO backup_jobs (id, project_id, name, machine_id, target_dir, sources_json, schedule_json, retention_json,
                              enabled, last_triggered_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    id, projectId, name, machine.id, targetDir, JSON.stringify(sources), JSON.stringify(schedule), JSON.stringify(retention), now, actor.id, now, now,
  );
  audit(ctx.db, { actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: 'project.backup.job.create', project_id: projectId, machine_id: machine.id, target_type: 'backup_job', target_id: id, result: 'success', detail: { name, target_dir: targetDir, sources: sources.map((s) => s.kind) } });
  return getJob(ctx, projectId, id);
}

export function updateJob(ctx: AppContext, projectId: string, jobId: string, input: JobInput, actor: Actor): JobRow {
  const job = getJob(ctx, projectId, jobId);
  const machine = loadMachine(ctx, input.machine_id === undefined ? job.machine_id : String(input.machine_id));
  const name = input.name === undefined ? job.name : jobName(input.name);
  const sources = input.sources === undefined ? parse<BackupSource[]>(job.sources_json, []) : normalizeBackupSources(input.sources);
  const schedule = input.schedule === undefined ? parse<BackupSchedule>(job.schedule_json, normalizeBackupSchedule({ mode: 'off' })) : normalizeBackupSchedule(input.schedule);
  const retention = input.retention === undefined ? parse<BackupRetention>(job.retention_json, normalizeBackupRetention({})) : normalizeBackupRetention(input.retention);
  const targetDir = input.target_dir === undefined && machine.id === job.machine_id ? job.target_dir : validateTargetDir(machine, input.target_dir ?? job.target_dir);
  if (name !== job.name && ctx.db.get('SELECT 1 FROM backup_jobs WHERE project_id = ? AND name = ? AND id <> ?', projectId, name, jobId)) {
    throw new AppError('CONFLICT', 'Ein Job mit diesem Namen existiert bereits');
  }
  const enabled = input.enabled === undefined ? job.enabled : input.enabled === false || input.enabled === 0 ? 0 : 1;
  ctx.db.run(
    `UPDATE backup_jobs SET name = ?, machine_id = ?, target_dir = ?, sources_json = ?, schedule_json = ?, retention_json = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    name, machine.id, targetDir, JSON.stringify(sources), JSON.stringify(schedule), JSON.stringify(retention), enabled, new Date().toISOString(), jobId,
  );
  audit(ctx.db, { actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: 'project.backup.job.update', project_id: projectId, machine_id: machine.id, target_type: 'backup_job', target_id: jobId, result: 'success', detail: { name, target_dir: targetDir } });
  return getJob(ctx, projectId, jobId);
}

/** Löscht nur den Job und die Verzeichniseinträge in DevDeck – Backup-Dateien auf der Maschine bleiben unangetastet. */
export function deleteJob(ctx: AppContext, projectId: string, jobId: string, actor: Actor): void {
  const job = getJob(ctx, projectId, jobId);
  ctx.db.run('DELETE FROM backup_jobs WHERE id = ?', jobId);
  audit(ctx.db, { actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: 'project.backup.job.delete', project_id: projectId, machine_id: job.machine_id, target_type: 'backup_job', target_id: jobId, result: 'success', detail: { name: job.name, files_kept_in: job.target_dir } });
}

function activeRun(ctx: AppContext, jobId: string): boolean {
  return Boolean(
    ctx.db.get(`SELECT 1 FROM project_backups WHERE job_id = ? AND status IN ('queued','running')`, jobId) ||
      ctx.db.get(`SELECT 1 FROM backup_restores WHERE job_id = ? AND status = 'running'`, jobId),
  );
}

/** Backup anstoßen (Agent führt aus). Liefert die Lauf-ID. */
export function startRun(ctx: AppContext, job: JobRow, trigger: 'manual' | 'schedule', actor: Actor): string {
  const machine = loadMachine(ctx, job.machine_id);
  assertMachineReady(machine, 'backup.run', true);
  if (activeRun(ctx, job.id)) throw new AppError('CONFLICT', 'Für diesen Job läuft bereits ein Backup oder Restore');
  const runId = randomUUID();
  const now = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO project_backups (id, job_id, project_id, status, trigger_kind, origin, created_at, updated_at, progress)
       VALUES (?, ?, ?, 'queued', ?, 'devdeck', ?, ?, 'Wartet auf den Agenten …')`,
      runId, job.id, job.project_id, trigger, now, now,
    );
    ctx.db.run('UPDATE backup_jobs SET last_triggered_at = ? WHERE id = ?', now, job.id);
  });
  enqueueCommand(ctx.db, {
    machineId: machine.id,
    action: 'backup.run',
    payload: {
      job_id: job.id,
      run_id: runId,
      target_dir: job.target_dir,
      sources: parse(job.sources_json, []),
      retention: parse(job.retention_json, {}),
      trigger,
    },
    requestedBy: actor.id,
    ttlSeconds: 30 * 60,
  });
  audit(ctx.db, { actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: 'project.backup.run', project_id: job.project_id, machine_id: machine.id, target_type: 'backup_job', target_id: job.id, result: 'success', detail: { trigger, run_id: runId } });
  return runId;
}

/** Backup-Ordner auf der Maschine einlesen (vorhandene Backups erkennen) und optional ein Backup prüfen. */
export function requestScan(ctx: AppContext, job: JobRow, requestedBy: string | null, verifyBundle?: string): string {
  const machine = loadMachine(ctx, job.machine_id);
  assertMachineReady(machine, 'backup.scan', false);
  return enqueueCommand(ctx.db, {
    machineId: machine.id,
    action: 'backup.scan',
    payload: { job_id: job.id, target_dir: job.target_dir, ...(verifyBundle ? { verify_bundle: verifyBundle } : {}) },
    requestedBy,
    ttlSeconds: 7 * 86_400, // wird nachgeholt, sobald eine Offline-Maschine wieder da ist
  });
}

export interface RestoreRequest {
  job: JobRow;
  backup: BackupRow;
  sourceIds: string[];
  user: { id: string; email: string };
}

/**
 * Restore anstoßen. Der Aufrufer (Route) hat bereits geprüft: Browser-Sitzung, Projekt-Owner, Bestätigungstext.
 * Hier wird der Bestätigungsnachweis ins Kommando geschrieben, damit der Agent ihn erneut prüft.
 */
export function startRestore(ctx: AppContext, req: RestoreRequest): string {
  const { job, backup, user } = req;
  if (backup.status !== 'success' || !backup.bundle_name) throw new AppError('CONFLICT', 'Nur erfolgreiche Backups lassen sich wiederherstellen');
  const machine = loadMachine(ctx, job.machine_id);
  assertMachineReady(machine, 'backup.restore', true);
  if (activeRun(ctx, job.id)) throw new AppError('CONFLICT', 'Für diesen Job läuft bereits ein Backup oder Restore');
  const sources = parse<BackupSource[]>(job.sources_json, []);
  const known = new Set(sources.map((s) => s.id));
  for (const id of req.sourceIds) if (!known.has(id)) throw new AppError('VALIDATION', `Unbekannte Quelle: ${id}`);

  const restoreId = randomUUID();
  const safetyRunId = randomUUID();
  const now = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO backup_restores (id, job_id, project_id, bundle_name, status, requested_by, started_at, updated_at, progress)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, 'Wartet auf den Agenten …')`,
      restoreId, job.id, job.project_id, backup.bundle_name, user.id, now, now,
    );
    ctx.db.run(
      `INSERT INTO project_backups (id, job_id, project_id, status, trigger_kind, origin, created_at, updated_at, progress)
       VALUES (?, ?, ?, 'queued', 'restore-safety', 'devdeck', ?, ?, 'Sicherheits-Backup vor dem Restore')`,
      safetyRunId, job.id, job.project_id, now, now,
    );
  });
  enqueueCommand(ctx.db, {
    machineId: machine.id,
    action: 'backup.restore',
    payload: {
      job_id: job.id,
      restore_id: restoreId,
      safety_run_id: safetyRunId,
      target_dir: job.target_dir,
      bundle_name: backup.bundle_name,
      sources,
      retention: parse(job.retention_json, {}),
      source_ids: req.sourceIds,
      confirmation: { phrase: RESTORE_CONFIRM_PHRASE, by: user.email, at: now },
    },
    requestedBy: user.id,
    ttlSeconds: 15 * 60,
  });
  audit(ctx.db, { actor_type: 'user', actor_id: user.id, actor_label: user.email, action: 'project.backup.restore', project_id: job.project_id, machine_id: machine.id, target_type: 'backup_job', target_id: job.id, result: 'success', detail: { bundle: backup.bundle_name, sources: req.sourceIds, restore_id: restoreId } });
  return restoreId;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function int(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function cleanBundles(v: unknown): BackupBundleInfo[] {
  if (!Array.isArray(v)) return [];
  const out: BackupBundleInfo[] = [];
  for (const raw of v.slice(0, 2000)) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const name = str(b.name, 40);
    const created = str(b.created_at, 40);
    if (!name || !/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(name) || !created || Number.isNaN(Date.parse(created))) continue;
    const verify = (b.verify ?? null) as { ok?: unknown; problems?: unknown } | null;
    out.push({
      name,
      created_at: new Date(created).toISOString(),
      size_bytes: int(b.size_bytes) ?? 0,
      format: b.format === 'devdeck' ? 'devdeck' : 'legacy',
      summary: b.summary && typeof b.summary === 'object' ? (b.summary as Record<string, unknown>) : {},
      ...(verify ? { verify: { ok: verify.ok === true, problems: Array.isArray(verify.problems) ? verify.problems.map((p) => String(p).slice(0, 300)).slice(0, 20) : [] } } : {}),
    });
  }
  return out;
}

/** Vorhandene Backups übernehmen/aktualisieren. `authoritative`: Einträge, die auf der Platte nicht mehr existieren, entfernen. */
function syncBundles(ctx: AppContext, job: JobRow, bundles: BackupBundleInfo[], authoritative: boolean): void {
  const now = new Date().toISOString();
  const { db } = ctx;
  db.transaction(() => {
    for (const b of bundles) {
      const existing = db.get<{ id: string }>('SELECT id FROM project_backups WHERE job_id = ? AND bundle_name = ?', job.id, b.name);
      const verifiedAt = b.verify?.ok ? now : null;
      if (existing) {
        db.run('UPDATE project_backups SET size_bytes = ?, summary_json = ?, updated_at = ? WHERE id = ?', b.size_bytes, JSON.stringify(b.summary), now, existing.id);
        if (b.verify) {
          db.run('UPDATE project_backups SET verify_json = ?, verified_at = ? WHERE id = ?', JSON.stringify(b.verify), verifiedAt, existing.id);
        }
      } else {
        db.run(
          `INSERT INTO project_backups (id, job_id, project_id, bundle_name, status, trigger_kind, origin, created_at, updated_at, finished_at,
                                        size_bytes, summary_json, verified_at, verify_json)
           VALUES (?, ?, ?, ?, 'success', 'discovered', 'discovered', ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(), job.id, job.project_id, b.name, b.created_at, now, b.created_at, b.size_bytes, JSON.stringify(b.summary),
          verifiedAt, b.verify ? JSON.stringify(b.verify) : null,
        );
      }
    }
    if (authoritative) {
      const keep = new Set(bundles.map((b) => b.name));
      const rows = db.all<{ id: string; bundle_name: string }>(
        `SELECT id, bundle_name FROM project_backups WHERE job_id = ? AND bundle_name IS NOT NULL AND status = 'success'`,
        job.id,
      );
      for (const r of rows) if (!keep.has(r.bundle_name)) db.run('DELETE FROM project_backups WHERE id = ?', r.id);
    }
  });
}

/** Meldung eines Agenten (Fortschritt/Ergebnis/Scan) verarbeiten. Nur der Agent der Job-Maschine darf melden. */
export function ingestReport(ctx: AppContext, machine: MachineRecord, raw: unknown): void {
  const r = (raw ?? {}) as Partial<BackupReport>;
  const jobId = str(r.job_id, 60);
  const job = jobId ? ctx.db.get<JobRow>('SELECT * FROM backup_jobs WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)', jobId) : undefined;
  if (!job) throw new AppError('NOT_FOUND', 'Backup-Job nicht gefunden');
  if (job.machine_id !== machine.id) throw new AppError('FORBIDDEN', 'Dieser Job gehört zu einer anderen Maschine');
  const now = new Date().toISOString();
  const status = r.status === 'running' || r.status === 'success' || r.status === 'failed' ? r.status : null;
  const { db } = ctx;

  if (r.kind === 'scan') {
    syncBundles(ctx, job, cleanBundles(r.bundles), true);
    requestReplicaSync(ctx, 'job', job.id);
    return;
  }

  if (r.kind === 'run') {
    const runId = str(r.run_id, 60);
    const run = runId ? db.get<BackupRow>('SELECT * FROM project_backups WHERE id = ? AND job_id = ?', runId, job.id) : undefined;
    if (!run || !status) throw new AppError('NOT_FOUND', 'Lauf nicht gefunden');
    if (run.status === 'success' || run.status === 'failed') return; // späte Meldung eines bereits abgeschlossenen Laufs
    if (status === 'running') {
      db.run(`UPDATE project_backups SET status = 'running', progress = ?, updated_at = ? WHERE id = ?`, str(r.progress, 300), now, run.id);
      return;
    }
    if (status === 'failed') {
      db.run(`UPDATE project_backups SET status = 'failed', error = ?, progress = NULL, updated_at = ?, finished_at = ? WHERE id = ?`, str(r.error, 1000) ?? 'Unbekannter Fehler', now, now, run.id);
      audit(db, { actor_type: 'agent', actor_id: machine.id, actor_label: machine.name, action: 'project.backup.finish', project_id: job.project_id, machine_id: machine.id, target_type: 'backup_job', target_id: job.id, result: 'failure', detail: { run_id: run.id, error: str(r.error, 300) } });
      return;
    }
    const bundle = cleanBundles(r.bundles)[0];
    if (!bundle) throw new AppError('VALIDATION', 'Ergebnis ohne Backup-Angaben');
    db.transaction(() => {
      db.run('DELETE FROM project_backups WHERE job_id = ? AND bundle_name = ? AND id <> ?', job.id, bundle.name, run.id);
      db.run(
        `UPDATE project_backups SET status = 'success', bundle_name = ?, created_at = ?, size_bytes = ?, summary_json = ?, progress = NULL, error = NULL,
           updated_at = ?, finished_at = ? WHERE id = ?`,
        bundle.name, bundle.created_at, bundle.size_bytes, JSON.stringify(bundle.summary), now, now, run.id,
      );
      if (Array.isArray(r.deleted)) {
        for (const name of r.deleted.slice(0, 1000)) {
          if (typeof name === 'string') db.run('DELETE FROM project_backups WHERE job_id = ? AND bundle_name = ?', job.id, name);
        }
      }
    });
    requestReplicaSync(ctx, 'job', job.id);
    audit(db, { actor_type: 'agent', actor_id: machine.id, actor_label: machine.name, action: 'project.backup.finish', project_id: job.project_id, machine_id: machine.id, target_type: 'backup_job', target_id: job.id, result: 'success', detail: { run_id: run.id, bundle: bundle.name, bytes: bundle.size_bytes, deleted: Array.isArray(r.deleted) ? r.deleted.length : 0 } });
    return;
  }

  if (r.kind === 'restore') {
    const restoreId = str(r.restore_id, 60);
    const row = restoreId ? db.get<RestoreRow>('SELECT * FROM backup_restores WHERE id = ? AND job_id = ?', restoreId, job.id) : undefined;
    if (!row || !status) throw new AppError('NOT_FOUND', 'Restore nicht gefunden');
    if (row.status !== 'running') return;
    if (status === 'running') {
      db.run('UPDATE backup_restores SET progress = ?, updated_at = ? WHERE id = ?', str(r.progress, 300), now, row.id);
      return;
    }
    db.run(
      'UPDATE backup_restores SET status = ?, summary_json = ?, error = ?, progress = NULL, updated_at = ?, finished_at = ? WHERE id = ?',
      status, r.summary ? JSON.stringify(r.summary) : null, str(r.error, 1000), now, now, row.id,
    );
    audit(db, { actor_type: 'agent', actor_id: machine.id, actor_label: machine.name, action: 'project.backup.restore.finish', project_id: job.project_id, machine_id: machine.id, target_type: 'backup_job', target_id: job.id, result: status === 'success' ? 'success' : 'failure', detail: { restore_id: row.id, bundle: row.bundle_name, error: str(r.error, 300) } });
    return;
  }
  throw new AppError('VALIDATION', 'Unbekannte Meldungsart');
}

/** Hängende Läufe (Agent beendet/neu gestartet, ohne Ergebnis) nach 20 Minuten ohne Lebenszeichen als fehlgeschlagen markieren. */
export function sweepStuckBackups(ctx: AppContext, now = Date.now()): number {
  const cutoff = new Date(now - 20 * 60_000).toISOString();
  const at = new Date(now).toISOString();
  const msg = 'Kein Lebenszeichen vom Agenten (Prozess vermutlich beendet oder neu gestartet)';
  const a = ctx.db.run(
    `UPDATE project_backups SET status = 'failed', error = ?, progress = NULL, finished_at = ? WHERE status IN ('queued','running') AND updated_at < ?`,
    msg, at, cutoff,
  );
  const b = ctx.db.run(
    `UPDATE backup_restores SET status = 'failed', error = ?, progress = NULL, finished_at = ? WHERE status = 'running' AND updated_at < ?`,
    msg, at, cutoff,
  );
  return a.changes + b.changes;
}

/** Zeitplan-Tick (jede Minute): fällige Jobs starten, sofern die Maschine online ist; sonst wird beim nächsten Tick nachgeholt. */
export function runBackupScheduleTick(ctx: AppContext, now = new Date()): string[] {
  sweepStuckBackups(ctx, now.getTime());
  const started: string[] = [];
  const jobs = ctx.db.all<JobRow>('SELECT * FROM backup_jobs WHERE enabled = 1 AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)');
  for (const job of jobs) {
    const schedule = parse<BackupSchedule | null>(job.schedule_json, null);
    if (!schedule || !isBackupDue(schedule, job.last_triggered_at, now)) continue;
    try {
      startRun(ctx, job, 'schedule', { id: null, label: 'zeitplan', type: 'system' });
      started.push(job.id);
    } catch (err) {
      // Wird beim nächsten Tick erneut versucht; der Grund erscheint (höchstens alle 6 Stunden einmal) im Backup-Log
      const reason = err instanceof AppError ? err.message : 'Unerwarteter Fehler beim Start';
      if (!(err instanceof AppError && err.code === 'CONFLICT')) {
        const since = new Date(now.getTime() - 6 * 3_600_000).toISOString();
        const seen = ctx.db.get(
          `SELECT 1 FROM project_backups WHERE job_id = ? AND trigger_kind = 'schedule' AND status = 'failed' AND error = ? AND created_at > ?`,
          job.id, `Geplantes Backup nicht gestartet: ${reason}`, since,
        );
        if (!seen) {
          const at = now.toISOString();
          ctx.db.run(
            `INSERT INTO project_backups (id, job_id, project_id, status, trigger_kind, origin, created_at, updated_at, finished_at, error)
             VALUES (?, ?, ?, 'failed', 'schedule', 'devdeck', ?, ?, ?, ?)`,
            randomUUID(), job.id, job.project_id, at, at, at, `Geplantes Backup nicht gestartet: ${reason}`,
          );
        }
      }
    }
  }
  return started;
}

// ── Ausgabe für die Oberfläche ──

export function jobDto(ctx: AppContext, job: JobRow, now = new Date()): Record<string, unknown> {
  const machine = ctx.db.get<{ id: string; name: string; platform: string; agent_status: string; agent_version: string | null }>(
    'SELECT id, name, platform, agent_status, agent_version FROM machines WHERE id = ?',
    job.machine_id,
  );
  const backups = ctx.db.all<BackupRow>('SELECT * FROM project_backups WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200', job.id);
  const restores = ctx.db.all<RestoreRow & { requested_by_email: string | null }>(
    `SELECT r.*, u.email AS requested_by_email FROM backup_restores r LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.job_id = ? ORDER BY r.started_at DESC LIMIT 5`,
    job.id,
  );
  const schedule = parse<BackupSchedule>(job.schedule_json, normalizeBackupSchedule({ mode: 'off' }));
  const ok = backups.filter((b) => b.status === 'success');
  return {
    id: job.id,
    project_id: job.project_id,
    name: job.name,
    machine,
    target_dir: job.target_dir,
    sources: parse<BackupSource[]>(job.sources_json, []),
    schedule,
    retention: parse<BackupRetention>(job.retention_json, normalizeBackupRetention({})),
    enabled: job.enabled === 1,
    replica: replicaDto(ctx, getReplica(ctx, 'job', job.id)),
    last_triggered_at: job.last_triggered_at,
    next_run_at: job.enabled === 1 ? nextScheduledRun(schedule, job.last_triggered_at, now)?.toISOString() ?? null : null,
    busy: backups.some((b) => b.status === 'queued' || b.status === 'running') || restores.some((r) => r.status === 'running'),
    stats: { count: ok.length, newest_success_at: ok[0]?.created_at ?? null, total_bytes: ok.reduce((n, b) => n + (b.size_bytes ?? 0), 0) },
    backups: backups.map((b) => ({
      id: b.id,
      bundle_name: b.bundle_name,
      status: b.status,
      trigger: b.trigger_kind,
      origin: b.origin,
      created_at: b.created_at,
      finished_at: b.finished_at,
      size_bytes: b.size_bytes,
      summary: parse(b.summary_json, {}),
      progress: b.progress,
      error: b.error,
      verified_at: b.verified_at,
      verify: parse(b.verify_json, null),
    })),
    restores: restores.map((r) => ({
      id: r.id,
      bundle_name: r.bundle_name,
      status: r.status,
      requested_by: r.requested_by_email,
      started_at: r.started_at,
      finished_at: r.finished_at,
      progress: r.progress,
      summary: parse(r.summary_json, null),
      error: r.error,
    })),
  };
}

export function getBackupRow(ctx: AppContext, jobId: string, backupId: string): BackupRow {
  const row = ctx.db.get<BackupRow>('SELECT * FROM project_backups WHERE id = ? AND job_id = ?', backupId, jobId);
  if (!row) throw new AppError('NOT_FOUND', 'Backup nicht gefunden');
  return row;
}

/** Maschinen, auf denen Backups liegen können: alle eingetragenen, mit Vorschlag für den Ordner. */
export function backupMachines(ctx: AppContext, projectId: string, slug: string): Array<Record<string, unknown>> {
  const machines = ctx.db.all<MachineRecord & { owner_email: string | null }>(
    `SELECT m.*, u.email AS owner_email FROM machines m LEFT JOIN users u ON u.id = m.owner_user_id
     WHERE m.revoked_at IS NULL ORDER BY m.name`,
  );
  return machines.map((m) => {
    const p = pathFor(m.platform);
    const workspaces = ctx.db.all<{ id: string; local_path: string }>('SELECT id, local_path FROM workspaces WHERE project_id = ? AND machine_id = ?', projectId, m.id);
    return {
      id: m.id,
      name: m.name,
      platform: m.platform,
      agent_status: m.agent_status,
      agent_version: m.agent_version,
      owner: m.owner_email,
      supported: agentSupportsAction(m.agent_version, 'backup.run'),
      workspaces,
      suggested_dir: m.workspace_root ? p.join(p.dirname(m.workspace_root), 'devdeck-backups', slug) : null,
    };
  });
}

// ── Erkennung ──

export interface SourceCandidate {
  id: string;
  kind: 'supabase' | 'postgres' | 'sqlite' | 'files';
  label: string;
  reason: string;
  suggested: boolean;
  available: boolean;
  missing?: string;
  config: Record<string, unknown>;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'quelle';

async function awaitCommand(ctx: AppContext, id: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = ctx.db.get<{ status: string; result_json: string | null }>('SELECT status, result_json FROM agent_commands WHERE id = ?', id);
    if (row?.status === 'done') return parse<Record<string, unknown> | null>(row.result_json, null);
    if (row?.status === 'failed' || row?.status === 'expired') return null;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Erkennt automatisch, was zu sichern ist:
 *  – Vault-Secrets (Supabase-URL + Service-Key → Datenbank und Storage, DATABASE_URL → Postgres),
 *  – SQLite-Dateien aus dem Workspace-Scan,
 *  – Datenordner (uploads, media, …) per Agent-Aktion `backup.detect` auf der gewählten Maschine,
 *  – vorhandene Backup-Ordner in der Umgebung der Workspaces.
 */
export async function detectSources(ctx: AppContext, projectId: string, machineId: string): Promise<{
  candidates: SourceCandidate[];
  backup_dirs: Array<{ path: string; bundles: number; newest: string | null }>;
  notes: string[];
}> {
  const machine = loadMachine(ctx, machineId);
  const p = pathFor(machine.platform);
  const candidates: SourceCandidate[] = [];
  const notes: string[] = [];

  const secrets = ctx.db.all<{ name: string; environment: string }>(`SELECT name, environment FROM secrets WHERE project_id = ? AND kind = 'env'`, projectId);
  const envs = [...new Set(secrets.map((s) => s.environment))].sort((a, b) => (a === 'production' ? -1 : b === 'production' ? 1 : a.localeCompare(b)));
  const find = (env: string, re: RegExp): string | undefined => secrets.find((s) => s.environment === env && re.test(s.name))?.name;
  const URL_RE = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_)?SUPABASE_URL$/;
  const KEY_RE = /^SUPABASE_(SERVICE_ROLE_KEY|SERVICE_KEY|SECRET_KEY)$/;
  const DB_RE = /^(DATABASE_URL|POSTGRES_URL|POSTGRES_URL_NON_POOLING|SUPABASE_DB_URL)$/;

  let supabaseFound = false;
  for (const env of envs) {
    const url = find(env, URL_RE);
    const key = find(env, KEY_RE);
    if (!key) continue;
    supabaseFound = true;
    candidates.push({
      id: 'supabase',
      kind: 'supabase',
      label: `Supabase (Datenbank + Storage, ${env})`,
      reason: `Secrets ${url ?? '(URL fehlt)'} und ${key} im Vault`,
      suggested: Boolean(url),
      available: Boolean(url),
      ...(url ? {} : { missing: 'Ein Secret mit der Supabase-URL (z. B. NEXT_PUBLIC_SUPABASE_URL) fehlt in diesem Projekt' }),
      config: { url_secret: url ?? 'SUPABASE_URL', key_secret: key, environment: env, buckets: [], schema: true },
    });
    break; // eine Supabase-Quelle je Job: bevorzugt production
  }
  for (const env of envs) {
    const name = find(env, DB_RE);
    if (!name) continue;
    candidates.push({
      id: 'postgres',
      kind: 'postgres',
      label: `PostgreSQL-Datenbank (${name}, ${env})`,
      reason: `Secret ${name} im Vault (benötigt pg_dump auf der Backup-Maschine)`,
      suggested: !supabaseFound,
      available: true,
      config: { url_secret: name, environment: env },
    });
    break;
  }

  const workspaces = ctx.db.all<{ id: string; local_path: string; facts_json: string | null }>(
    'SELECT id, local_path, facts_json FROM workspaces WHERE project_id = ? AND machine_id = ?',
    projectId, machine.id,
  );
  if (!supabaseFound) {
    const factEnv = workspaces.flatMap((w) => (parse<{ env?: Array<{ name: string }> }>(w.facts_json, {}).env ?? []).map((e) => e.name));
    if (factEnv.some((n) => /SUPABASE/.test(n))) notes.push('Der Workspace verwendet Supabase, aber im Vault fehlen die Zugangsdaten (Service-Role-Key und URL als Secrets anlegen), daher kann es nicht gesichert werden.');
  }

  const used = new Set(candidates.map((c) => c.id));
  const unique = (base: string): string => {
    let id = base;
    for (let i = 2; used.has(id); i += 1) id = `${base.slice(0, 36)}-${i}`;
    used.add(id);
    return id;
  };

  for (const w of workspaces) {
    const dbs = parse<{ databases?: Array<{ path: string; bytes: number }> }>(w.facts_json, {}).databases ?? [];
    for (const d of dbs) {
      const abs = p.join(w.local_path, ...d.path.split('/'));
      candidates.push({ id: unique(`sqlite-${slug(path.posix.basename(d.path))}`), kind: 'sqlite', label: `SQLite-Datenbank ${d.path}`, reason: 'Im Workspace gefunden', suggested: true, available: true, config: { path: abs } });
    }
  }

  const backupDirs: Array<{ path: string; bundles: number; newest: string | null }> = [];
  if (machine.agent_status === 'online' && agentSupportsAction(machine.agent_version, 'backup.detect')) {
    const pending = workspaces.slice(0, 3).map((w) => enqueueCommand(ctx.db, { machineId: machine.id, action: 'backup.detect', payload: { workspace_id: w.id, local_path: w.local_path }, ttlSeconds: 120 }));
    const results = await Promise.all(pending.map((id) => awaitCommand(ctx, id, 15_000)));
    for (const res of results) {
      if (!res) continue;
      const dirs = (res.dirs ?? []) as Array<{ path: string; rel: string; bytes: number; files: number; truncated: boolean; hasSecrets: boolean }>;
      for (const d of dirs) {
        const sizeMb = Math.round((d.bytes / 1024 / 1024) * 10) / 10;
        candidates.push({
          id: unique(`files-${slug(d.rel)}`),
          kind: 'files',
          label: `Ordner ${d.rel}`,
          reason: `${d.files}${d.truncated ? '+' : ''} Dateien, ${sizeMb} MB`,
          suggested: !d.hasSecrets,
          available: !d.hasSecrets,
          ...(d.hasSecrets ? { missing: 'Enthält Zugangsdaten (.env, Schlüssel) – nicht automatisch gesichert' } : {}),
          config: { path: d.path, exclude: [] },
        });
      }
      for (const b of (res.backup_dirs ?? []) as Array<{ path: string; bundles: number; newest: string | null }>) {
        if (!backupDirs.some((x) => x.path === b.path)) backupDirs.push(b);
      }
    }
    if (workspaces.length === 0) notes.push(`Auf „${machine.name}“ gibt es keinen Workspace dieses Projekts – Ordner und lokale Datenbanken können dort nicht erkannt werden (Datenbanken aus dem Vault schon).`);
  } else {
    notes.push(`„${machine.name}“ ist offline oder hat einen älteren Agenten: Ordner und vorhandene Backups wurden nicht gesucht.`);
  }
  return { candidates, backup_dirs: backupDirs, notes };
}

export interface BackupLogEntry {
  at: string;
  kind: 'backup' | 'restore' | 'agent';
  level: 'error' | 'info';
  job: string | null;
  machine: string | null;
  title: string;
  message: string | null;
}

/** Backup-Log eines Projekts: Läufe, Restores und fehlgeschlagene Agent-Aufträge (neueste zuerst). */
export function backupLog(ctx: AppContext, projectId: string, limit = 200): BackupLogEntry[] {
  const out: BackupLogEntry[] = [];
  const runs = ctx.db.all<{ at: string; status: string; trigger_kind: string; bundle_name: string | null; error: string | null; size_bytes: number | null; job: string; machine: string | null }>(
    `SELECT COALESCE(b.finished_at, b.created_at) AS at, b.status, b.trigger_kind, b.bundle_name, b.error, b.size_bytes, j.name AS job, m.name AS machine
     FROM project_backups b JOIN backup_jobs j ON j.id = b.job_id LEFT JOIN machines m ON m.id = j.machine_id
     WHERE b.project_id = ? AND b.origin = 'devdeck' AND b.status IN ('success','failed') ORDER BY at DESC LIMIT ?`,
    projectId, limit,
  );
  const label: Record<string, string> = { manual: 'manuell', schedule: 'Zeitplan', 'restore-safety': 'Sicherheits-Backup vor Restore' };
  for (const r of runs) {
    out.push({
      at: r.at, kind: 'backup', level: r.status === 'failed' ? 'error' : 'info', job: r.job, machine: r.machine,
      title: r.status === 'failed' ? `Backup fehlgeschlagen (${label[r.trigger_kind] ?? r.trigger_kind})` : `Backup erstellt (${label[r.trigger_kind] ?? r.trigger_kind})`,
      message: r.status === 'failed' ? r.error : `${r.bundle_name ?? ''}${r.size_bytes != null ? `, ${r.size_bytes} Bytes` : ''}`,
    });
  }
  const restores = ctx.db.all<{ at: string; status: string; bundle_name: string; error: string | null; job: string; machine: string | null }>(
    `SELECT COALESCE(r.finished_at, r.started_at) AS at, r.status, r.bundle_name, r.error, j.name AS job, m.name AS machine
     FROM backup_restores r JOIN backup_jobs j ON j.id = r.job_id LEFT JOIN machines m ON m.id = j.machine_id
     WHERE r.project_id = ? AND r.status <> 'running' ORDER BY at DESC LIMIT ?`,
    projectId, limit,
  );
  for (const r of restores) {
    out.push({ at: r.at, kind: 'restore', level: r.status === 'failed' ? 'error' : 'info', job: r.job, machine: r.machine,
      title: r.status === 'failed' ? 'Restore fehlgeschlagen' : 'Restore abgeschlossen', message: r.error ?? r.bundle_name });
  }
  const cmds = ctx.db.all<{ at: string; action: string; status: string; error: string | null; job: string | null; machine: string | null }>(
    `SELECT COALESCE(c.finished_at, c.created_at) AS at, c.action, c.status, c.error, j.name AS job, m.name AS machine
     FROM agent_commands c JOIN backup_jobs j ON j.id = json_extract(c.payload_json, '$.job_id') LEFT JOIN machines m ON m.id = c.machine_id
     WHERE j.project_id = ? AND c.action LIKE 'backup.%' AND c.status IN ('failed','expired') ORDER BY at DESC LIMIT ?`,
    projectId, limit,
  );
  const names: Record<string, string> = { 'backup.run': 'Backup-Start', 'backup.scan': 'Ordner einlesen/Prüfen', 'backup.restore': 'Restore-Start', 'backup.detect': 'Erkennung' };
  for (const c of cmds) {
    out.push({ at: c.at, kind: 'agent', level: 'error', job: c.job, machine: c.machine,
      title: `${names[c.action] ?? c.action} fehlgeschlagen`, message: c.status === 'expired' ? 'Der Agent hat den Auftrag nicht rechtzeitig abgeholt (Maschine offline?)' : c.error });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
