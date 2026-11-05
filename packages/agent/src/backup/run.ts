import fs from 'node:fs';
import path from 'node:path';
import {
  AppError,
  BACKUP_MANIFEST_FILE,
  BUNDLE_NAME_PATTERN,
  bundleNameFor,
  selectBundlesToDelete,
  type BackupBundleInfo,
  type BackupReport,
  type BackupRetention,
  type BackupSource,
} from '@devdeck/shared';
import type { ServerClient } from '../client.js';
import type { AgentConfig } from '../config.js';
import { log } from '../logger.js';
import { resolveWorkspacePath } from '../actions/workspaceStatus.js';
import { buildItems, newManifestBase, scanBundles, writeManifest, type SourceResult } from './bundle.js';
import { dirBytes, safeJoin } from './fsutil.js';
import { backupDirectory, backupPostgres, backupSqlite } from './local.js';
import { backupSupabase, legacyManifestFields, type SupabaseBackupResult } from './supabase.js';

/** Pro Job läuft höchstens ein Backup bzw. Restore gleichzeitig. */
const activeJobs = new Set<string>();

export function claimJob(jobId: string): void {
  if (activeJobs.has(jobId)) throw new AppError('CONFLICT', 'Für diesen Job läuft bereits ein Backup oder Restore');
  activeJobs.add(jobId);
}

export function releaseJob(jobId: string): void {
  activeJobs.delete(jobId);
}

/** Meldet Fortschritt/Ergebnis an den Server; sendet zusätzlich alle 30 s ein Lebenszeichen, damit lange Läufe nicht als hängend gelten. */
export class Reporter {
  private current = '';
  private timer: NodeJS.Timeout | null = null;
  private lastSent = 0;

  constructor(
    private readonly client: ServerClient,
    private readonly base: Pick<BackupReport, 'job_id' | 'kind' | 'run_id' | 'restore_id'>,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.send({ status: 'running', progress: this.current }), 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  progress(text: string): void {
    this.current = text;
    if (Date.now() - this.lastSent > 5_000) void this.send({ status: 'running', progress: text });
  }

  async send(extra: Partial<BackupReport>): Promise<void> {
    this.lastSent = Date.now();
    try {
      const res = await this.client.request('POST', '/api/agent/backups/report', { body: { ...this.base, ...extra }, timeoutMs: 30_000 });
      if (res.status >= 400) log.warn(`Backup-Meldung abgelehnt (${res.status}): ${res.error?.message ?? ''}`);
    } catch (err) {
      log.warn(`Backup-Meldung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const secretKey = (environment: string, name: string): string => `${environment}::${name}`;

/** Secrets der Quellen beim Server abholen (Vault, nur was die Quellen brauchen; Berechtigung des Maschinen-Besitzers). */
export async function fetchJobSecrets(client: ServerClient, jobId: string, sources: BackupSource[]): Promise<Record<string, string>> {
  const wanted: Array<{ name: string; environment: string }> = [];
  for (const s of sources) {
    if (!s.enabled) continue;
    const environment = String(s.config.environment ?? 'production');
    if (s.kind === 'supabase') wanted.push({ name: String(s.config.url_secret), environment }, { name: String(s.config.key_secret), environment });
    if (s.kind === 'postgres') wanted.push({ name: String(s.config.url_secret), environment });
  }
  if (wanted.length === 0) return {};
  const res = await client.request<{ secrets: Record<string, string> }>('POST', `/api/agent/backup-jobs/${jobId}/secrets`, { body: { names: wanted } });
  if (res.status !== 200 || !res.data) {
    throw new AppError('SECRET_UNAVAILABLE', res.error?.message ?? 'Secrets konnten nicht bezogen werden (Berechtigung/Vault)');
  }
  return res.data.secrets;
}

export function needSecret(secrets: Record<string, string>, environment: string, name: string): string {
  const value = secrets[secretKey(environment, name)];
  if (!value) throw new AppError('SECRET_UNAVAILABLE', `Secret ${name} (${environment}) fehlt im Vault oder ist für diese Maschine nicht freigegeben`);
  return value;
}

/** Ziel muss ein absoluter, nicht-trivialer Pfad sein (nie das Wurzelverzeichnis). */
export function checkTargetDir(targetDir: string): string {
  if (!path.isAbsolute(targetDir)) throw new AppError('VALIDATION', 'Der Backup-Ordner muss ein absoluter Pfad sein');
  const resolved = path.resolve(targetDir);
  if (path.dirname(resolved) === resolved) throw new AppError('VALIDATION', 'Das Wurzelverzeichnis ist als Backup-Ordner nicht zulässig');
  return resolved;
}

export interface RunOptions {
  client: ServerClient;
  config: AgentConfig;
  jobId: string;
  runId: string;
  targetDir: string;
  sources: BackupSource[];
  retention: BackupRetention;
  trigger: string;
  /** false: Aufbewahrung nicht anwenden (z. B. Sicherheits-Backup vor einem Restore) */
  applyRetention?: boolean;
}

export interface RunOutcome {
  bundle: BackupBundleInfo;
  deleted: string[];
}

function removeStalePartials(targetDir: string): void {
  for (const e of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (e.isDirectory() && /^\.\d{4}-\d{2}-\d{2}_\d{6}\.partial$/.test(e.name)) {
      fs.rmSync(path.join(targetDir, e.name), { recursive: true, force: true });
    }
  }
}

/** Backups löschen, die die Aufbewahrung nicht mehr vorsieht – ausschließlich echte Backup-Ordner (Zeitstempelname + Manifest) im Zielordner. */
export function applyRetentionTo(targetDir: string, retention: BackupRetention, now = new Date()): string[] {
  const bundles = scanBundles(targetDir).map((b) => ({ name: b.name, created_at: b.created_at }));
  const deleted: string[] = [];
  for (const name of selectBundlesToDelete(bundles, retention, now)) {
    if (!BUNDLE_NAME_PATTERN.test(name)) continue;
    const dir = safeJoin(targetDir, name);
    if (!fs.existsSync(path.join(dir, BACKUP_MANIFEST_FILE))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    deleted.push(name);
  }
  return deleted;
}

/** Ein Backup erstellen: alle aktiven Quellen in einen Ordner, Manifest mit Prüfsummen, atomar umbenennen, Aufbewahrung anwenden. */
export async function createBackup(options: RunOptions, reporter: Reporter): Promise<RunOutcome> {
  const { client, config, jobId, sources, trigger } = options;
  const targetDir = checkTargetDir(options.targetDir);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  removeStalePartials(targetDir);

  const enabled = sources.filter((s) => s.enabled);
  // Ordner-Quellen dürfen den Backup-Ordner nicht enthalten (sonst sichert sich das Backup selbst)
  const resolved = new Map<string, string>();
  for (const s of enabled) {
    if (s.kind !== 'files' && s.kind !== 'sqlite') continue;
    const p = resolveWorkspacePath({ config }, s.config.path);
    resolved.set(s.id, p);
    const rel = path.relative(p, targetDir);
    if (s.kind === 'files' && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new AppError('VALIDATION', `Der Backup-Ordner liegt innerhalb der Quelle „${s.label}“ – bitte einen anderen Ordner wählen`);
    }
  }

  const secrets = await fetchJobSecrets(client, jobId, enabled);
  const started = Date.now();
  const name = bundleNameFor(new Date());
  const finalDir = path.join(targetDir, name);
  if (fs.existsSync(finalDir)) throw new AppError('CONFLICT', `Es gibt bereits ein Backup mit dem Namen ${name} – bitte eine Sekunde warten`);
  const partial = path.join(targetDir, `.${name}.partial`);
  fs.mkdirSync(partial, { recursive: true, mode: 0o700 });

  const results: SourceResult[] = [];
  let supabase: { access: { url: string; key: string }; result: SupabaseBackupResult } | null = null;
  try {
    for (const s of enabled) {
      reporter.progress(`${s.label} …`);
      const environment = String(s.config.environment ?? 'production');
      if (s.kind === 'supabase') {
        const access = {
          url: needSecret(secrets, environment, String(s.config.url_secret)),
          key: needSecret(secrets, environment, String(s.config.key_secret)),
        };
        const result = await backupSupabase({
          access,
          bundleDir: partial,
          targetDir,
          buckets: (s.config.buckets as string[] | undefined) ?? [],
          schema: s.config.schema !== false,
          progress: (t) => reporter.progress(`${s.label}: ${t}`),
        });
        supabase = { access, result };
        results.push({
          id: s.id, kind: s.kind, label: s.label,
          bytes: dirBytes(path.join(partial, 'database')) + dirBytes(path.join(partial, 'storage')) + dirBytes(path.join(partial, 'schema')),
          detail: { tables: result.tables.length, rows: result.rows, storage_files: result.storage_files, buckets: result.storage_buckets },
        });
      } else if (s.kind === 'postgres') {
        const bytes = await backupPostgres(needSecret(secrets, environment, String(s.config.url_secret)), path.join(partial, 'postgres', `${s.id}.dump`));
        results.push({ id: s.id, kind: s.kind, label: s.label, bytes, detail: {} });
      } else if (s.kind === 'sqlite') {
        const bytes = await backupSqlite(resolved.get(s.id)!, path.join(partial, 'sqlite', `${s.id}.sqlite`));
        results.push({ id: s.id, kind: s.kind, label: s.label, bytes, detail: {} });
      } else {
        const bytes = await backupDirectory(resolved.get(s.id)!, path.join(partial, 'files', `${s.id}.tar.gz`), (s.config.exclude as string[] | undefined) ?? []);
        results.push({ id: s.id, kind: s.kind, label: s.label, bytes, detail: {} });
      }
    }

    reporter.progress('Prüfsummen berechnen …');
    const items = await buildItems(partial);
    const duration = (Date.now() - started) / 1000;
    const manifest = newManifestBase(jobId, trigger, Math.round(duration * 10) / 10, results, items);
    if (supabase) Object.assign(manifest, legacyManifestFields(supabase.result, supabase.access, partial, duration));
    writeManifest(partial, manifest);
    fs.renameSync(partial, finalDir);
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw err;
  }

  const deleted = options.applyRetention === false ? [] : applyRetentionTo(targetDir, options.retention);
  const bundle = scanBundles(targetDir).find((b) => b.name === name);
  if (!bundle) throw new AppError('INTERNAL', 'Das Backup wurde geschrieben, ist aber nicht lesbar');
  return { bundle, deleted };
}

/** Hintergrund-Lauf für die Aktion `backup.run`: meldet Erfolg oder Fehler an den Server. */
export async function runBackupJob(options: RunOptions): Promise<void> {
  const reporter = new Reporter(options.client, { job_id: options.jobId, kind: 'run', run_id: options.runId });
  reporter.start();
  try {
    await reporter.send({ status: 'running', progress: 'Start …' });
    const { bundle, deleted } = await createBackup(options, reporter);
    reporter.stop();
    await reporter.send({
      status: 'success',
      bundle_name: bundle.name,
      created_at: bundle.created_at,
      size_bytes: bundle.size_bytes,
      summary: bundle.summary,
      bundles: [bundle],
      deleted,
    });
    log.info(`Backup ${bundle.name} erstellt (${bundle.size_bytes} Bytes), ${deleted.length} alte gelöscht`);
  } catch (err) {
    reporter.stop();
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Backup fehlgeschlagen: ${message}`);
    await reporter.send({ status: 'failed', error: message.slice(0, 1000) });
  } finally {
    releaseJob(options.jobId);
  }
}
