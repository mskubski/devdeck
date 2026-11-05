import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, agentSupportsAction, isReplicableBundleName, isSafeTransferPath, BACKUP_MANIFEST_FILE, type TransferFile } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import type { MachineRecord } from '../auth/middleware.js';
import { audit } from './audit.js';
import { enqueueCommand } from './provisioning.js';

/**
 * Replikation: Backups (System-Backups des Servers oder Backup-Jobs eines Projekts) werden auf eine zweite Maschine kopiert.
 * Die Agenten bauen nur ausgehende Verbindungen auf – deshalb läuft die Kopie über den Server:
 *   Projekt-Job:  Quell-Agent → (Staging auf dem Server) → Ziel-Agent
 *   System:       Server-Ordner → Ziel-Agent (kein Staging nötig)
 * Die Replik ist ein Spiegel: Was beim Primären durch die Aufbewahrung gelöscht wird, wird auch auf der Replik gelöscht
 * (nur Ordner mit Backup-Namen und Manifest; nie, wenn die Liste des Primären leer ist).
 */

export type ReplicaScope = 'system' | 'job';
type State = 'idle' | 'pruning' | 'exporting' | 'importing';

export interface ReplicaRow {
  id: string;
  scope: ReplicaScope;
  job_id: string | null;
  job_key: string;
  machine_id: string;
  target_dir: string;
  enabled: number;
  state: State;
  cur_command_id: string | null;
  cur_bundle: string | null;
  state_since: string | null;
  sync_requested: number;
  last_check_at: string | null;
  last_sync_at: string | null;
  last_ok: number | null;
  last_message: string | null;
  present_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Actor {
  id: string | null;
  label: string;
  type: 'user' | 'system';
}

const SYSTEM_KEY = 'system';
/** Zwischen zwei Abgleichen ohne Anlass vergehen höchstens 30 Minuten; ein hängender Schritt wird nach 3 Stunden abgebrochen. */
const RECHECK_MS = 30 * 60_000;
const STEP_TIMEOUT_MS = 3 * 3_600_000;
/** Obergrenze für den Zwischenspeicher auf dem Server (Bytes). */
export const STAGING_MAX_BYTES = Number(process.env.DEVDECK_REPLICA_STAGING_MAX_GB ?? 20) * 1024 ** 3;

const pathFor = (platform: string): typeof path.posix => (platform === 'win32' ? path.win32 : path.posix);
const parse = <T>(v: string | null | undefined, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ───────────────────────────── Zwischenspeicher (Staging) ─────────────────────────────

export const stagingRoot = (ctx: AppContext): string => path.join(ctx.config.dataDir, 'replica-staging');
export const stagingDir = (ctx: AppContext, replicaId: string, bundle: string): string => path.join(stagingRoot(ctx), replicaId, bundle);
export const stagingIndex = (ctx: AppContext, replicaId: string, bundle: string): string => path.join(stagingRoot(ctx), replicaId, `${bundle}.index.json`);

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* verschwunden */
        }
      }
    }
  };
  walk(dir);
  return total;
}

export const stagingUsage = (ctx: AppContext): number => dirSize(stagingRoot(ctx));

export function clearStaging(ctx: AppContext, replicaId: string, bundle?: string): void {
  if (bundle) {
    fs.rmSync(stagingDir(ctx, replicaId, bundle), { recursive: true, force: true });
    fs.rmSync(stagingIndex(ctx, replicaId, bundle), { force: true });
  } else {
    fs.rmSync(path.join(stagingRoot(ctx), replicaId), { recursive: true, force: true });
  }
}

/** Staging-Ordner von Repliken, die es nicht mehr gibt oder die gerade nichts übertragen, aufräumen. */
function sweepStaging(ctx: AppContext): void {
  let ids: string[];
  try {
    ids = fs.readdirSync(stagingRoot(ctx));
  } catch {
    return;
  }
  for (const id of ids) {
    const row = ctx.db.get<{ state: string }>('SELECT state FROM backup_replicas WHERE id = ?', id);
    if (!row || row.state === 'idle' || row.state === 'pruning') clearStaging(ctx, id);
  }
}

// ───────────────────────────── Konfiguration ─────────────────────────────

function loadMachine(ctx: AppContext, machineId: string): MachineRecord {
  const m = ctx.db.get<MachineRecord>('SELECT * FROM machines WHERE id = ?', machineId);
  if (!m || m.revoked_at) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden oder widerrufen');
  return m;
}

function validateDir(machine: MachineRecord, dir: unknown): string {
  if (typeof dir !== 'string' || dir.trim() === '' || dir.length > 500) throw new AppError('VALIDATION', 'Ordner der Replik fehlt');
  const p = pathFor(machine.platform);
  if (!p.isAbsolute(dir)) throw new AppError('VALIDATION', `Der Ordner der Replik muss ein absoluter Pfad auf „${machine.name}“ sein`);
  const resolved = p.resolve(dir);
  if (p.dirname(resolved) === resolved) throw new AppError('VALIDATION', 'Das Wurzelverzeichnis ist als Ordner der Replik nicht zulässig');
  return resolved;
}

function needAgent(machine: MachineRecord, actions: Array<'backup.import' | 'backup.prune' | 'backup.export'>): void {
  for (const a of actions) {
    if (!agentSupportsAction(machine.agent_version, a)) {
      throw new AppError(
        'VALIDATION',
        `Der Agent auf „${machine.name}“ (Version ${machine.agent_version ?? 'unbekannt'}) kann Backups noch nicht replizieren. Bitte zuerst aktualisieren: System → „Server aktualisieren“ (mit Agents) oder Maschinen → „Agent updaten“.`,
      );
    }
  }
}

export function getReplica(ctx: AppContext, scope: ReplicaScope, jobId: string | null): ReplicaRow | undefined {
  return ctx.db.get<ReplicaRow>('SELECT * FROM backup_replicas WHERE job_key = ?', scope === 'system' ? SYSTEM_KEY : jobId);
}

export function getReplicaById(ctx: AppContext, id: string): ReplicaRow | undefined {
  return ctx.db.get<ReplicaRow>('SELECT * FROM backup_replicas WHERE id = ?', id);
}

interface JobBrief {
  id: string;
  project_id: string;
  name: string;
  machine_id: string;
  target_dir: string;
}

function jobBrief(ctx: AppContext, jobId: string): JobBrief {
  const job = ctx.db.get<JobBrief>('SELECT id, project_id, name, machine_id, target_dir FROM backup_jobs WHERE id = ?', jobId);
  if (!job) throw new AppError('NOT_FOUND', 'Backup-Job nicht gefunden');
  return job;
}

export interface ReplicaInput {
  machine_id?: unknown;
  target_dir?: unknown;
  enabled?: unknown;
}

/** Replik einrichten oder ändern. Bei neuer Maschine/neuem Ordner wird der Bestand neu abgeglichen (alle vorhandenen Backups werden kopiert). */
export function setReplica(ctx: AppContext, scope: ReplicaScope, jobId: string | null, input: ReplicaInput, actor: Actor): ReplicaRow {
  const job = scope === 'job' ? jobBrief(ctx, jobId ?? '') : null;
  const existing = getReplica(ctx, scope, jobId);
  const machine = loadMachine(ctx, String(input.machine_id ?? existing?.machine_id ?? ''));
  const dir = validateDir(machine, input.target_dir ?? existing?.target_dir);
  needAgent(machine, ['backup.import', 'backup.prune']);
  if (job) {
    if (job.machine_id === machine.id) throw new AppError('VALIDATION', 'Die Replik muss auf einer anderen Maschine liegen als das Primär-Backup – sonst schützt sie nicht vor deren Ausfall');
    needAgent(loadMachine(ctx, job.machine_id), ['backup.export']);
  }
  const enabled = input.enabled === undefined ? (existing ? existing.enabled : 1) : input.enabled === false || input.enabled === 0 ? 0 : 1;
  const now = new Date().toISOString();
  if (existing) {
    const moved = existing.machine_id !== machine.id || existing.target_dir !== dir;
    if (moved) clearStaging(ctx, existing.id);
    ctx.db.run(
      `UPDATE backup_replicas SET machine_id = ?, target_dir = ?, enabled = ?, updated_at = ?,
         state = CASE WHEN ? THEN 'idle' ELSE state END, cur_command_id = CASE WHEN ? THEN NULL ELSE cur_command_id END,
         cur_bundle = CASE WHEN ? THEN NULL ELSE cur_bundle END, present_json = CASE WHEN ? THEN NULL ELSE present_json END,
         sync_requested = 1 WHERE id = ?`,
      machine.id, dir, enabled, now, moved ? 1 : 0, moved ? 1 : 0, moved ? 1 : 0, moved ? 1 : 0, existing.id,
    );
  } else {
    ctx.db.run(
      `INSERT INTO backup_replicas (id, scope, job_id, job_key, machine_id, target_dir, enabled, state, sync_requested, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', 1, ?, ?, ?)`,
      randomUUID(), scope, jobId, scope === 'system' ? SYSTEM_KEY : jobId, machine.id, dir, enabled, actor.id, now, now,
    );
  }
  const row = getReplica(ctx, scope, jobId)!;
  audit(ctx.db, {
    actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: existing ? 'backup.replica.update' : 'backup.replica.create',
    project_id: job?.project_id ?? undefined, machine_id: machine.id, target_type: 'backup_replica', target_id: row.id, result: 'success',
    detail: { scope, target_dir: dir, enabled: Boolean(enabled) },
  });
  return row;
}

/** Replik entfernen. Die bereits kopierten Backups auf der Ziel-Maschine bleiben unangetastet. */
export function removeReplica(ctx: AppContext, scope: ReplicaScope, jobId: string | null, actor: Actor): void {
  const row = getReplica(ctx, scope, jobId);
  if (!row) throw new AppError('NOT_FOUND', 'Keine Replik eingerichtet');
  clearStaging(ctx, row.id);
  ctx.db.run('DELETE FROM backup_replicas WHERE id = ?', row.id);
  const job = row.job_id ? ctx.db.get<{ project_id: string }>('SELECT project_id FROM backup_jobs WHERE id = ?', row.job_id) : undefined;
  audit(ctx.db, {
    actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: 'backup.replica.delete',
    project_id: job?.project_id ?? undefined, machine_id: row.machine_id, target_type: 'backup_replica', target_id: row.id, result: 'success',
    detail: { scope, files_kept_in: row.target_dir },
  });
}

/** Abgleich beim nächsten Tick anstoßen (z. B. nach einem neuen Backup oder nach der Aufbewahrung). */
export function requestReplicaSync(ctx: AppContext, scope: ReplicaScope, jobId: string | null): void {
  ctx.db.run('UPDATE backup_replicas SET sync_requested = 1 WHERE job_key = ? AND enabled = 1', scope === 'system' ? SYSTEM_KEY : jobId);
}

// ───────────────────────────── Abgleich ─────────────────────────────

/** Backups des Primären, die gespiegelt werden sollen (neueste zuerst). */
export function primaryBundles(ctx: AppContext, row: ReplicaRow): string[] {
  const names = row.scope === 'job'
    ? ctx.db.all<{ n: string }>(`SELECT bundle_name AS n FROM project_backups WHERE job_id = ? AND status = 'success' AND bundle_name IS NOT NULL`, row.job_id).map((r) => r.n)
    : ctx.db.all<{ target_path: string }>(`SELECT target_path FROM backups WHERE kind = 'system' AND status = 'success'`).map((r) => path.basename(r.target_path));
  return [...new Set(names.filter(isReplicableBundleName))].sort().reverse();
}

/** Ordner eines System-Backups auf dem Server (nur innerhalb des Backup-Ziels). */
export function systemBundleDir(ctx: AppContext, bundle: string): string | null {
  const r = ctx.db.get<{ target_path: string }>(`SELECT target_path FROM backups WHERE kind = 'system' AND status = 'success' AND target_path LIKE ?`, `%${bundle}`);
  if (!r || path.basename(r.target_path) !== bundle) return null;
  const rel = path.relative(ctx.config.backupTarget, r.target_path);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? r.target_path : null;
}

function cmdState(ctx: AppContext, id: string | null): { status: string; result: Record<string, unknown> | null; error: string | null } | null {
  if (!id) return null;
  const c = ctx.db.get<{ status: string; result_json: string | null; error: string | null }>('SELECT status, result_json, error FROM agent_commands WHERE id = ?', id);
  return c ? { status: c.status, result: parse<Record<string, unknown> | null>(c.result_json, null), error: c.error } : null;
}

function setState(ctx: AppContext, row: ReplicaRow, patch: Partial<Pick<ReplicaRow, 'state' | 'cur_command_id' | 'cur_bundle' | 'last_message'>>): void {
  const merged = { ...row, ...patch };
  ctx.db.run(
    'UPDATE backup_replicas SET state = ?, cur_command_id = ?, cur_bundle = ?, last_message = ?, state_since = ? WHERE id = ?',
    merged.state, merged.cur_command_id, merged.cur_bundle, merged.last_message, new Date().toISOString(), row.id,
  );
}

function finish(ctx: AppContext, row: ReplicaRow, ok: boolean, message: string): void {
  const now = new Date().toISOString();
  ctx.db.run(
    `UPDATE backup_replicas SET state = 'idle', cur_command_id = NULL, cur_bundle = NULL, state_since = NULL, sync_requested = 0,
       last_check_at = ?, last_sync_at = CASE WHEN ? = 1 THEN ? ELSE last_sync_at END, last_ok = ?, last_message = ? WHERE id = ?`,
    now, ok ? 1 : 0, now, ok ? 1 : 0, message.slice(0, 500), row.id,
  );
  if (!ok) {
    audit(ctx.db, { actor_type: 'system', actor_label: 'replikation', action: 'backup.replica.sync', machine_id: row.machine_id, target_type: 'backup_replica', target_id: row.id, result: 'failure', detail: { error: message.slice(0, 300) } });
  }
}

function online(ctx: AppContext, machineId: string): MachineRecord | null {
  const m = ctx.db.get<MachineRecord>('SELECT * FROM machines WHERE id = ?', machineId);
  return m && !m.revoked_at && m.agent_status === 'online' ? m : null;
}

function startPrune(ctx: AppContext, row: ReplicaRow): void {
  const target = online(ctx, row.machine_id);
  if (!target) {
    ctx.db.run('UPDATE backup_replicas SET last_message = ? WHERE id = ?', 'Ziel-Maschine ist offline – der Abgleich wird nachgeholt', row.id);
    return;
  }
  const keep = primaryBundles(ctx, row);
  const id = enqueueCommand(ctx.db, {
    machineId: row.machine_id, action: 'backup.prune',
    // Ohne Backups beim Primären wird nie etwas gelöscht (z. B. wenn dessen Ordner gerade nicht lesbar war)
    payload: { replica_id: row.id, target_dir: row.target_dir, keep, delete: keep.length > 0 },
    ttlSeconds: 3600,
  });
  setState(ctx, row, { state: 'pruning', cur_command_id: id, cur_bundle: null, last_message: 'Prüft die Replik …' });
}

function startTransfer(ctx: AppContext, row: ReplicaRow, bundle: string): void {
  if (row.scope === 'system') {
    startImport(ctx, row, bundle);
    return;
  }
  const job = jobBrief(ctx, row.job_id ?? '');
  const source = online(ctx, job.machine_id);
  if (!source) {
    finish(ctx, row, false, 'Die Maschine mit dem Primär-Backup ist offline – wird beim nächsten Abgleich nachgeholt');
    return;
  }
  if (stagingUsage(ctx) > STAGING_MAX_BYTES) {
    finish(ctx, row, false, 'Der Zwischenspeicher auf dem Server ist voll – Abgleich später erneut');
    return;
  }
  clearStaging(ctx, row.id, bundle);
  fs.mkdirSync(stagingDir(ctx, row.id, bundle), { recursive: true });
  const id = enqueueCommand(ctx.db, {
    machineId: job.machine_id, action: 'backup.export',
    payload: { replica_id: row.id, job_id: job.id, target_dir: job.target_dir, bundle },
    ttlSeconds: 3600,
  });
  setState(ctx, row, { state: 'exporting', cur_command_id: id, cur_bundle: bundle, last_message: `Liest Backup ${bundle} von der Quelle …` });
}

function startImport(ctx: AppContext, row: ReplicaRow, bundle: string): void {
  if (!online(ctx, row.machine_id)) {
    finish(ctx, row, false, 'Ziel-Maschine ist offline – wird beim nächsten Abgleich nachgeholt');
    return;
  }
  const id = enqueueCommand(ctx.db, {
    machineId: row.machine_id, action: 'backup.import',
    payload: { replica_id: row.id, target_dir: row.target_dir, bundle },
    ttlSeconds: 3600,
  });
  setState(ctx, row, { state: 'importing', cur_command_id: id, cur_bundle: bundle, last_message: `Kopiert Backup ${bundle} auf die Ziel-Maschine …` });
}

function nextMissing(ctx: AppContext, row: ReplicaRow): string | null {
  const present = new Set(parse<string[]>(row.present_json, []));
  return primaryBundles(ctx, row).find((b) => !present.has(b)) ?? null;
}

/** Einen Schritt der Zustandsmaschine einer Replik ausführen. */
function stepReplica(ctx: AppContext, row: ReplicaRow, now: number): void {
  if (row.state === 'idle') {
    const due = row.sync_requested === 1 || !row.last_check_at || now - Date.parse(row.last_check_at) > RECHECK_MS;
    if (due) startPrune(ctx, row);
    return;
  }
  if (row.state_since && now - Date.parse(row.state_since) > STEP_TIMEOUT_MS) {
    clearStaging(ctx, row.id);
    finish(ctx, row, false, 'Zeitüberschreitung beim Abgleich – wird erneut versucht');
    return;
  }
  const cmd = cmdState(ctx, row.cur_command_id);
  if (!cmd || cmd.status === 'queued' || cmd.status === 'running') {
    if (!cmd) finish(ctx, row, false, 'Auftrag ging verloren – wird erneut versucht');
    return;
  }
  if (cmd.status !== 'done') {
    clearStaging(ctx, row.id);
    finish(ctx, row, false, cmd.status === 'expired' ? 'Die Maschine hat den Auftrag nicht rechtzeitig abgeholt (offline?)' : (cmd.error ?? 'Auftrag fehlgeschlagen'));
    return;
  }

  if (row.state === 'pruning') {
    const present = Array.isArray(cmd.result?.present) ? (cmd.result!.present as unknown[]).filter((n): n is string => typeof n === 'string' && isReplicableBundleName(n)) : [];
    ctx.db.run('UPDATE backup_replicas SET present_json = ? WHERE id = ?', JSON.stringify(present), row.id);
    const fresh = getReplicaById(ctx, row.id)!;
    const bundle = nextMissing(ctx, fresh);
    if (!bundle) {
      const n = primaryBundles(ctx, fresh).length;
      finish(ctx, fresh, true, n === 0 ? 'Noch keine Backups zum Kopieren' : `${n} Backup${n === 1 ? '' : 's'} synchron`);
    } else startTransfer(ctx, fresh, bundle);
    return;
  }
  if (row.state === 'exporting') {
    if (!row.cur_bundle || !fs.existsSync(stagingIndex(ctx, row.id, row.cur_bundle))) {
      clearStaging(ctx, row.id);
      finish(ctx, row, false, 'Die Quelle hat das Backup nicht vollständig übergeben');
      return;
    }
    startImport(ctx, row, row.cur_bundle);
    return;
  }
  if (row.state === 'importing') {
    const bundle = row.cur_bundle!;
    clearStaging(ctx, row.id, bundle);
    const present = [...new Set([...parse<string[]>(row.present_json, []), bundle])];
    ctx.db.run('UPDATE backup_replicas SET present_json = ? WHERE id = ?', JSON.stringify(present), row.id);
    const fresh = getReplicaById(ctx, row.id)!;
    const more = nextMissing(ctx, fresh);
    if (more) startTransfer(ctx, fresh, more);
    else {
      const n = primaryBundles(ctx, fresh).length;
      finish(ctx, fresh, true, `${n} Backup${n === 1 ? '' : 's'} synchron`);
      audit(ctx.db, { actor_type: 'system', actor_label: 'replikation', action: 'backup.replica.sync', machine_id: fresh.machine_id, target_type: 'backup_replica', target_id: fresh.id, result: 'success', detail: { bundles: n } });
    }
  }
}

/** Zeitplan-Tick (alle ~20 Sekunden): jede aktive Replik einen Schritt weiterbringen. */
export function runReplicaTick(ctx: AppContext, now = Date.now()): void {
  sweepStaging(ctx);
  const rows = ctx.db.all<ReplicaRow>(
    `SELECT * FROM backup_replicas WHERE enabled = 1 AND (job_id IS NULL OR job_id IN (SELECT j.id FROM backup_jobs j JOIN projects p ON p.id = j.project_id WHERE p.deleted_at IS NULL))`,
  );
  for (const row of rows) {
    try {
      stepReplica(ctx, row, now);
    } catch (err) {
      clearStaging(ctx, row.id);
      finish(ctx, row, false, err instanceof AppError ? err.message : 'Unerwarteter Fehler beim Abgleich');
    }
  }
}

// ───────────────────────────── Übertragung (Agent ↔ Server) ─────────────────────────────

/** Dateiliste eines Backups für den Ziel-Agenten: aus dem Staging (Projekt-Job) bzw. direkt aus dem Server-Ordner (System). */
export function transferFiles(ctx: AppContext, row: ReplicaRow, bundle: string): TransferFile[] {
  if (row.scope === 'job') {
    const files = parse<TransferFile[]>(fs.existsSync(stagingIndex(ctx, row.id, bundle)) ? fs.readFileSync(stagingIndex(ctx, row.id, bundle), 'utf8') : null, []);
    if (!files.length) throw new AppError('NOT_FOUND', 'Backup liegt nicht im Zwischenspeicher');
    return files;
  }
  const dir = systemBundleDir(ctx, bundle);
  if (!dir) throw new AppError('NOT_FOUND', 'System-Backup nicht gefunden');
  const out: TransferFile[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) {
        const full = path.join(d, e.name);
        out.push({ path: rel, sha256: sha256Sync(full), bytes: fs.statSync(full).size });
      }
    }
  };
  walk(dir, '');
  return out;
}

function sha256Sync(file: string): string {
  // Dateien eines System-Backups sind klein (Datenbank-Snapshots); in Blöcken lesen, damit der Speicher nicht wächst
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Aufgelöster Pfad einer Datei im Zwischenspeicher bzw. im System-Backup (nie außerhalb). */
export function transferFilePath(ctx: AppContext, row: ReplicaRow, bundle: string, rel: unknown): string {
  if (!isSafeTransferPath(rel)) throw new AppError('VALIDATION', 'Ungültiger Dateipfad');
  const base = row.scope === 'job' ? stagingDir(ctx, row.id, bundle) : systemBundleDir(ctx, bundle);
  if (!base) throw new AppError('NOT_FOUND', 'Backup nicht gefunden');
  const full = path.resolve(base, ...rel.split('/'));
  if (!full.startsWith(path.resolve(base) + path.sep)) throw new AppError('FORBIDDEN', 'Pfad außerhalb des Backups');
  return full;
}

/** Schreibt die Dateiliste des Zwischenspeichers, nachdem die Quelle alle Dateien übergeben hat; prüft Vollständigkeit. */
export function completeStaging(ctx: AppContext, row: ReplicaRow, bundle: string, raw: unknown): number {
  const list = (raw as { files?: unknown })?.files;
  if (!Array.isArray(list) || list.length === 0 || list.length > 200_000) throw new AppError('VALIDATION', 'files: Liste der Dateien erwartet');
  const files: TransferFile[] = [];
  for (const f of list) {
    const p = (f as { path?: unknown })?.path;
    if (!isSafeTransferPath(p)) throw new AppError('VALIDATION', 'Ungültiger Dateipfad in der Liste');
    const sha = String((f as { sha256?: unknown }).sha256 ?? '');
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new AppError('VALIDATION', 'Ungültige Prüfsumme in der Liste');
    const full = transferFilePath(ctx, row, bundle, p);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      throw new AppError('VALIDATION', `Datei fehlt im Zwischenspeicher: ${p}`);
    }
    if (size !== Number((f as { bytes?: unknown }).bytes)) throw new AppError('VALIDATION', `Größe stimmt nicht: ${p}`);
    files.push({ path: p, sha256: sha, bytes: size });
  }
  if (!files.some((f) => f.path === BACKUP_MANIFEST_FILE)) throw new AppError('VALIDATION', 'Das Backup enthält kein Manifest');
  fs.writeFileSync(stagingIndex(ctx, row.id, bundle), JSON.stringify(files));
  return files.length;
}

// ───────────────────────────── Ausgabe für die Oberfläche ─────────────────────────────

export function replicaDto(ctx: AppContext, row: ReplicaRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const machine = ctx.db.get<{ id: string; name: string; platform: string; agent_status: string }>('SELECT id, name, platform, agent_status FROM machines WHERE id = ?', row.machine_id);
  const primary = primaryBundles(ctx, row);
  const present = new Set(parse<string[]>(row.present_json, []));
  return {
    id: row.id,
    scope: row.scope,
    machine,
    target_dir: row.target_dir,
    enabled: row.enabled === 1,
    state: row.state,
    busy: row.state !== 'idle',
    current_bundle: row.cur_bundle,
    last_check_at: row.last_check_at,
    last_sync_at: row.last_sync_at,
    last_ok: row.last_ok === null ? null : row.last_ok === 1,
    message: row.last_message,
    primary_count: primary.length,
    replicated_count: primary.filter((b) => present.has(b)).length,
  };
}

function machineChoices(ctx: AppContext, sourceDir: string, sourcePlatform: string | null, slug: string): Array<Record<string, unknown>> {
  const machines = ctx.db.all<MachineRecord>('SELECT * FROM machines WHERE revoked_at IS NULL ORDER BY name');
  return machines.map((m) => {
    const p = pathFor(m.platform);
    // Vorschlag: derselbe Pfad wie beim Primären (DevDeck-Standardpfad), wenn er auf der Ziel-Maschine gültig ist; sonst neben dem Workspace-Root
    const samePath = sourcePlatform === null ? (p.isAbsolute(sourceDir) ? sourceDir : null) : ((sourcePlatform === 'win32') === (m.platform === 'win32') && p.isAbsolute(sourceDir) ? sourceDir : null);
    const beside = m.workspace_root ? p.join(p.dirname(m.workspace_root), 'devdeck-backups', slug) : null;
    return {
      id: m.id, name: m.name, platform: m.platform, agent_status: m.agent_status, agent_version: m.agent_version,
      supported: agentSupportsAction(m.agent_version, 'backup.import') && agentSupportsAction(m.agent_version, 'backup.prune'),
      suggested_dir: samePath ?? beside,
      alternative_dir: samePath && beside ? beside : null,
    };
  });
}

/** Maschinen-Auswahl mit Ordner-Vorschlag für die Replik eines Jobs (ohne die Maschine des Primär-Backups). */
export function jobReplicaOptions(ctx: AppContext, jobId: string): Array<Record<string, unknown>> {
  const job = ctx.db.get<{ id: string; machine_id: string; target_dir: string; platform: string; slug: string }>(
    `SELECT j.id, j.machine_id, j.target_dir, m.platform, p.slug FROM backup_jobs j JOIN machines m ON m.id = j.machine_id JOIN projects p ON p.id = j.project_id WHERE j.id = ?`,
    jobId,
  );
  if (!job) throw new AppError('NOT_FOUND', 'Backup-Job nicht gefunden');
  return machineChoices(ctx, job.target_dir, job.platform, job.slug).filter((m) => m.id !== job.machine_id);
}

/** Übersicht für die Backup-Seite (Admin): System-Backups und alle Projekt-Jobs mit Replik-Zustand und Maschinen-Auswahl. */
export function replicaOverview(ctx: AppContext): Record<string, unknown> {
  const jobs = ctx.db.all<{ id: string; name: string; project_id: string; project_name: string; project_slug: string; machine_id: string; machine_name: string; machine_platform: string; target_dir: string }>(
    `SELECT j.id, j.name, j.project_id, p.name AS project_name, p.slug AS project_slug, j.machine_id, m.name AS machine_name, m.platform AS machine_platform, j.target_dir
     FROM backup_jobs j JOIN projects p ON p.id = j.project_id JOIN machines m ON m.id = j.machine_id WHERE p.deleted_at IS NULL ORDER BY p.name, j.name`,
  );
  const systemCount = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM backups WHERE kind = 'system' AND status = 'success'`)?.n ?? 0;
  return {
    system: {
      source: { label: 'DevDeck-Server', dir: ctx.config.backupTarget, backups: systemCount },
      replica: replicaDto(ctx, getReplica(ctx, 'system', null)),
      machines: machineChoices(ctx, ctx.config.backupTarget, null, 'devdeck-system'),
    },
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      project: { id: j.project_id, name: j.project_name, slug: j.project_slug },
      source: { machine: j.machine_name, platform: j.machine_platform, dir: j.target_dir, backups: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM project_backups WHERE job_id = ? AND status = 'success'`, j.id)?.n ?? 0 },
      replica: replicaDto(ctx, getReplica(ctx, 'job', j.id)),
      machines: machineChoices(ctx, j.target_dir, j.machine_platform, j.project_slug).filter((m) => m.id !== j.machine_id),
    })),
  };
}
