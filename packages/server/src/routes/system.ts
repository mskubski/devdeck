import { Router } from 'express';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http.js';
import { requireSystemRole, requireUser } from '../auth/middleware.js';
import { getUpdateState, getVersionInfo, startSelfUpdate } from '../services/selfUpdate.js';

/** System-Update per Knopfdruck (nur Admin). */
export function systemRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db), requireSystemRole('admin'));

  router.get(
    '/system/version',
    asyncHandler(async (req, res) => {
      res.json({ data: await getVersionInfo(ctx, req.query.refresh === '1') });
    }),
  );

  router.get('/system/update', (_req, res) => {
    res.json({ data: getUpdateState() });
  });

  router.post(
    '/system/update',
    asyncHandler(async (req, res) => {
      startSelfUpdate(ctx, { id: req.user!.id, label: req.user!.email });
      res.status(202).json({ data: getUpdateState() });
    }),
  );

  return router;
}
