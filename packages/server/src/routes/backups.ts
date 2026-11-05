import { Router } from 'express';
import { AppError } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, param } from '../http.js';
import { requireSystemRole, requireUser } from '../auth/middleware.js';
import {
  applyRetention,
  createSystemBackup,
  getBackup,
  listBackups,
  verifyBackup,
} from '../services/backups.js';
import { getReplica, removeReplica, replicaDto, replicaOverview, requestReplicaSync, setReplica } from '../services/backupReplicas.js';
import { requireConfirmation } from '../http.js';

/**
 * System-Backups (nur Admin). Es gibt bewusst KEINEN Restore-Endpunkt:
 * Restore läuft nur interaktiv per `node dist/restore.js` (siehe restore.ts).
 */
export function backupRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db), requireSystemRole('admin'));

  const actorOf = (req: Parameters<Parameters<typeof router.get>[1]>[0]) => ({
    id: req.user!.id,
    label: req.user!.email,
    type: 'user' as const,
  });

  router.get(
    '/backups',
    asyncHandler(async (_req, res) => {
      res.json({
        data: {
          target: ctx.config.backupTarget,
          interval_hours: ctx.config.backupIntervalHours,
          retention: { daily: ctx.config.backupRetentionDaily, weekly: ctx.config.backupRetentionWeekly },
          backups: listBackups(ctx),
          replica: replicaDto(ctx, getReplica(ctx, 'system', null)),
        },
      });
    }),
  );

  // Replikation: Übersicht über System-Backups und alle Projekt-Jobs (Quelle, Ziel, Zustand) samt Maschinen-Auswahl
  router.get(
    '/backup-replicas',
    asyncHandler(async (_req, res) => {
      res.json({ data: replicaOverview(ctx) });
    }),
  );

  router.put(
    '/backups/replica',
    asyncHandler(async (req, res) => {
      setReplica(ctx, 'system', null, req.body ?? {}, actorOf(req));
      res.json({ data: replicaDto(ctx, getReplica(ctx, 'system', null)) });
    }),
  );

  router.delete(
    '/backups/replica',
    asyncHandler(async (req, res) => {
      requireConfirmation(req.body);
      removeReplica(ctx, 'system', null, actorOf(req));
      res.status(204).end();
    }),
  );

  router.post(
    '/backups/replica/sync',
    asyncHandler(async (_req, res) => {
      if (!getReplica(ctx, 'system', null)) throw new AppError('NOT_FOUND', 'Keine Replik eingerichtet');
      requestReplicaSync(ctx, 'system', null);
      res.status(202).json({ data: replicaDto(ctx, getReplica(ctx, 'system', null)) });
    }),
  );

  router.post(
    '/backups',
    asyncHandler(async (req, res) => {
      const row = createSystemBackup(ctx, actorOf(req));
      if (row.status === 'success') applyRetention(ctx);
      requestReplicaSync(ctx, 'system', null);
      res.status(row.status === 'success' ? 201 : 500).json({ data: row });
    }),
  );

  router.post(
    '/backups/:id/verify',
    asyncHandler(async (req, res) => {
      const result = verifyBackup(ctx, param(req, 'id')!, actorOf(req));
      res.json({ data: { ...result, backup: getBackup(ctx, param(req, 'id')!) } });
    }),
  );

  return router;
}
