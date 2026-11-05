import { Router, type Request } from 'express';
import { AppError, RESTORE_CONFIRM_PHRASE } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, param, parseCookies, requireConfirmation, requireString } from '../http.js';
import { requireProjectRole, requireUser, SESSION_COOKIE } from '../auth/middleware.js';
import {
  backupMachines,
  createJob,
  deleteJob,
  detectSources,
  getBackupRow,
  getJob,
  jobDto,
  requestScan,
  startRestore,
  startRun,
  updateJob,
  type JobRow,
} from '../services/projectBackups.js';

/**
 * Projekt-Backups (Tab „Backups“): Jobs mit Quellen, Maschine, Zeitplan und Aufbewahrung.
 * Restore: nur Projekt-Owner/Admin, nur aus einer Browser-Sitzung (nicht per CLI-Token) und nur mit dem
 * wörtlich eingetippten Bestätigungstext – der Server prüft ihn, der Agent erneut.
 */
export function projectBackupRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  const actorOf = (req: Request) => ({ id: req.user!.id, label: req.user!.email, type: 'user' as const });
  const jobOf = (req: Request): JobRow => getJob(ctx, req.project!.id, param(req, 'jobId')!);
  const base = '/projects/:projectId/backup-jobs';

  router.get(
    base,
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const jobs = db.all<JobRow>('SELECT * FROM backup_jobs WHERE project_id = ? ORDER BY created_at', req.project!.id);
      res.json({ data: jobs.map((j) => jobDto(ctx, j)) });
    }),
  );

  router.get(
    '/projects/:projectId/backup-machines',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      res.json({ data: backupMachines(ctx, req.project!.id, req.project!.slug) });
    }),
  );

  router.post(
    `${base}/detect`,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      res.json({ data: await detectSources(ctx, req.project!.id, requireString(req.body, 'machine_id')) });
    }),
  );

  router.post(
    base,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const job = createJob(ctx, req.project!.id, req.body ?? {}, actorOf(req));
      // Vorhandene Backups im Zielordner erkennen (wird nachgeholt, wenn die Maschine gerade offline ist)
      try {
        requestScan(ctx, job, req.user!.id);
      } catch {
        /* Agent zu alt: Hinweis kommt beim ersten Lauf */
      }
      res.status(201).json({ data: jobDto(ctx, job) });
    }),
  );

  router.patch(
    `${base}/:jobId`,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const before = jobOf(req);
      const job = updateJob(ctx, req.project!.id, before.id, req.body ?? {}, actorOf(req));
      if (job.target_dir !== before.target_dir || job.machine_id !== before.machine_id) {
        try {
          requestScan(ctx, job, req.user!.id);
        } catch {
          /* siehe oben */
        }
      }
      res.json({ data: jobDto(ctx, job) });
    }),
  );

  router.delete(
    `${base}/:jobId`,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      requireConfirmation(req.body);
      deleteJob(ctx, req.project!.id, jobOf(req).id, actorOf(req));
      res.status(204).end();
    }),
  );

  router.post(
    `${base}/:jobId/run`,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const runId = startRun(ctx, jobOf(req), 'manual', actorOf(req));
      res.status(202).json({ data: { run_id: runId } });
    }),
  );

  router.post(
    `${base}/:jobId/scan`,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      res.status(202).json({ data: { command_id: requestScan(ctx, jobOf(req), req.user!.id) } });
    }),
  );

  router.post(
    `${base}/:jobId/backups/:backupId/verify`,
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const job = jobOf(req);
      const backup = getBackupRow(ctx, job.id, param(req, 'backupId')!);
      if (backup.status !== 'success' || !backup.bundle_name) throw new AppError('CONFLICT', 'Nur erfolgreiche Backups lassen sich prüfen');
      res.status(202).json({ data: { command_id: requestScan(ctx, job, req.user!.id, backup.bundle_name) } });
    }),
  );

  router.post(
    `${base}/:jobId/backups/:backupId/restore`,
    requireProjectRole(db, 'owner'),
    asyncHandler(async (req, res) => {
      // 1) nur Browser-Sitzung – ein CLI-/Bearer-Token genügt nie
      if (!parseCookies(req)[SESSION_COOKIE]) {
        throw new AppError('FORBIDDEN', 'Ein Restore kann nur in der Web-Oberfläche (Browser-Anmeldung) gestartet werden');
      }
      // 2) Bestätigungstext wörtlich
      const typed = (req.body as { confirm_text?: unknown } | undefined)?.confirm_text;
      if (typed !== RESTORE_CONFIRM_PHRASE) {
        throw new AppError('CONFIRMATION_REQUIRED', `Zum Starten des Restores muss „${RESTORE_CONFIRM_PHRASE}“ exakt eingegeben werden`);
      }
      const job = jobOf(req);
      const backup = getBackupRow(ctx, job.id, param(req, 'backupId')!);
      const ids = (req.body as { source_ids?: unknown }).source_ids;
      const sourceIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
      const restoreId = startRestore(ctx, { job, backup, sourceIds, user: { id: req.user!.id, email: req.user!.email } });
      res.status(202).json({ data: { restore_id: restoreId } });
    }),
  );

  return router;
}
