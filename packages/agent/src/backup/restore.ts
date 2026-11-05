import fs from 'node:fs';
import path from 'node:path';
import {
  AppError,
  BUNDLE_NAME_PATTERN,
  RESTORE_CONFIRM_PHRASE,
  type BackupRetention,
  type BackupSource,
} from '@devdeck/shared';
import type { ServerClient } from '../client.js';
import type { AgentConfig } from '../config.js';
import { log } from '../logger.js';
import { resolveWorkspacePath } from '../actions/workspaceStatus.js';
import { readManifest, verifyBundleDir } from './bundle.js';
import { safeJoin } from './fsutil.js';
import { restoreDirectory, restorePostgres, restoreSqlite } from './local.js';
import { checkTargetDir, createBackup, fetchJobSecrets, needSecret, releaseJob, Reporter } from './run.js';
import { restoreSupabase } from './supabase.js';

export interface RestoreOptions {
  client: ServerClient;
  config: AgentConfig;
  jobId: string;
  restoreId: string;
  /** Lauf-ID des Sicherheits-Backups, das vor dem Restore erstellt wird */
  safetyRunId: string;
  targetDir: string;
  bundleName: string;
  sources: BackupSource[];
  retention: BackupRetention;
  /** nur diese Quellen zurückspielen (leer = alle im Backup vorhandenen) */
  sourceIds: string[];
  confirmation: { phrase: string; by: string; at: string };
}

/**
 * Backup zurückspielen. Ausschließlich über die bestätigte Aktion `backup.restore`:
 *  1. Bestätigungstext wird hier erneut geprüft (Server prüft ihn ebenfalls).
 *  2. Das Backup muss intakt sein (Prüfsummen).
 *  3. Vor jedem Eingriff wird ein Sicherheits-Backup des aktuellen Zustands erstellt; scheitert es, wird abgebrochen.
 *  4. Dateien/SQLite-Datenbanken werden nicht überschrieben, sondern in `_pre-restore-<Zeit>` beiseitegelegt.
 *     Supabase wird per Upsert zurückgeschrieben (nichts wird gelöscht).
 */
export async function runRestoreJob(options: RestoreOptions): Promise<void> {
  const reporter = new Reporter(options.client, { job_id: options.jobId, kind: 'restore', restore_id: options.restoreId });
  reporter.start();
  try {
    await reporter.send({ status: 'running', progress: 'Prüfe Backup …' });
    if (options.confirmation?.phrase !== RESTORE_CONFIRM_PHRASE) {
      throw new AppError('CONFIRMATION_REQUIRED', 'Restore ohne gültige Bestätigung abgelehnt');
    }
    const targetDir = checkTargetDir(options.targetDir);
    if (!BUNDLE_NAME_PATTERN.test(options.bundleName)) throw new AppError('VALIDATION', 'Ungültiger Backup-Name');
    const bundleDir = safeJoin(targetDir, options.bundleName);
    const manifest = readManifest(bundleDir);
    if (!manifest) throw new AppError('NOT_FOUND', `Backup ${options.bundleName} nicht gefunden`);
    const check = await verifyBundleDir(bundleDir);
    if (!check.ok) throw new AppError('VALIDATION', `Backup ist beschädigt, Restore abgebrochen: ${check.problems.slice(0, 3).join('; ')}`);

    // Sicherheits-Backup des aktuellen Zustands (ohne Aufbewahrung, damit dabei nichts gelöscht wird)
    const safetyReporter = new Reporter(options.client, { job_id: options.jobId, kind: 'run', run_id: options.safetyRunId });
    safetyReporter.start();
    try {
      await safetyReporter.send({ status: 'running', progress: 'Sicherheits-Backup vor dem Restore …' });
      const safety = await createBackup(
        { client: options.client, config: options.config, jobId: options.jobId, runId: options.safetyRunId, targetDir, sources: options.sources, retention: options.retention, trigger: 'restore-safety', applyRetention: false },
        safetyReporter,
      );
      safetyReporter.stop();
      await safetyReporter.send({ status: 'success', bundle_name: safety.bundle.name, created_at: safety.bundle.created_at, size_bytes: safety.bundle.size_bytes, summary: safety.bundle.summary, bundles: [safety.bundle] });
    } catch (err) {
      safetyReporter.stop();
      const message = err instanceof Error ? err.message : String(err);
      await safetyReporter.send({ status: 'failed', error: message.slice(0, 1000) });
      throw new AppError('INTERNAL', `Sicherheits-Backup fehlgeschlagen, Restore abgebrochen (es wurde nichts verändert): ${message}`);
    }

    const wanted = options.sourceIds.length > 0 ? options.sourceIds : options.sources.map((s) => s.id);
    const selected = options.sources.filter((s) => s.enabled && wanted.includes(s.id));
    if (selected.length === 0) throw new AppError('VALIDATION', 'Keine Quelle zum Wiederherstellen ausgewählt');
    const secrets = await fetchJobSecrets(options.client, options.jobId, selected);
    const preDir = path.join(targetDir, `_pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const done: Array<Record<string, unknown>> = [];
    const problems: string[] = [];

    for (const s of selected) {
      reporter.progress(`Restore: ${s.label} …`);
      const environment = String(s.config.environment ?? 'production');
      if (s.kind === 'supabase') {
        if (!fs.existsSync(path.join(bundleDir, 'database')) && !fs.existsSync(path.join(bundleDir, 'storage'))) {
          problems.push(`${s.label}: im Backup nicht enthalten`);
          continue;
        }
        const r = await restoreSupabase({
          access: { url: needSecret(secrets, environment, String(s.config.url_secret)), key: needSecret(secrets, environment, String(s.config.key_secret)) },
          bundleDir,
          progress: (t) => reporter.progress(t),
        });
        done.push({ id: s.id, kind: s.kind, tables: r.tables, rows: r.rows, files: r.files });
        for (const f of r.failed) problems.push(`${s.label}: Tabelle ${f}`);
      } else if (s.kind === 'postgres') {
        await restorePostgres(path.join(bundleDir, 'postgres', `${s.id}.dump`), needSecret(secrets, environment, String(s.config.url_secret)));
        done.push({ id: s.id, kind: s.kind });
      } else if (s.kind === 'sqlite') {
        restoreSqlite(path.join(bundleDir, 'sqlite', `${s.id}.sqlite`), resolveWorkspacePath({ config: options.config }, s.config.path), preDir, s.id);
        done.push({ id: s.id, kind: s.kind });
      } else {
        await restoreDirectory(path.join(bundleDir, 'files', `${s.id}.tar.gz`), resolveWorkspacePath({ config: options.config }, s.config.path), preDir, s.id);
        done.push({ id: s.id, kind: s.kind });
      }
    }
    reporter.stop();
    const hasPre = fs.existsSync(preDir);
    await reporter.send({
      status: problems.length > 0 ? 'failed' : 'success',
      summary: { restored: done, ...(hasPre ? { previous_state_saved_in: preDir } : {}) },
      ...(problems.length > 0 ? { error: `Teilweise wiederhergestellt: ${problems.join('; ').slice(0, 900)}` } : {}),
    });
    log.info(`Restore ${options.bundleName} abgeschlossen (${done.length} Quellen, ${problems.length} Probleme), angefordert von ${options.confirmation.by}`);
  } catch (err) {
    reporter.stop();
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Restore fehlgeschlagen: ${message}`);
    await reporter.send({ status: 'failed', error: message.slice(0, 1000) });
  } finally {
    releaseJob(options.jobId);
  }
}
