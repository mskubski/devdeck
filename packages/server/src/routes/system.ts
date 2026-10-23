import { Router } from 'express';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http.js';
import { requireSystemRole, requireUser } from '../auth/middleware.js';
import { AppError } from '@devdeck/shared';
import { audit } from '../services/audit.js';
import { getAutoUpdateSettings, saveAutoUpdateSettings } from '../services/autoUpdate.js';
import { getSetting } from '../services/settings.js';
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
      startSelfUpdate(
        ctx,
        { id: req.user!.id, label: req.user!.email, type: 'user' },
        { agents: req.body?.agents !== false },
      );
      res.status(202).json({ data: getUpdateState() });
    }),
  );

  // Einstellungen: automatisches nächtliches Update + Ergebnis des letzten Updates
  router.get('/system/settings', (_req, res) => {
    const s = getAutoUpdateSettings(ctx);
    const last = getSetting(db, 'last_update');
    res.json({
      data: {
        auto_update_enabled: s.enabled,
        auto_update_hour: s.hour,
        last_update: last ? JSON.parse(last) : null,
      },
    });
  });

  router.put(
    '/system/settings',
    asyncHandler(async (req, res) => {
      const current = getAutoUpdateSettings(ctx);
      const enabled = req.body?.auto_update_enabled === undefined ? current.enabled : req.body.auto_update_enabled === true;
      const hour = req.body?.auto_update_hour === undefined ? current.hour : Number(req.body.auto_update_hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new AppError('VALIDATION', 'auto_update_hour muss eine Stunde von 0 bis 23 sein');
      }
      saveAutoUpdateSettings(ctx, { enabled, hour });
      audit(db, {
        actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email,
        action: 'system.settings.update', target_type: 'system', result: 'success',
        detail: { auto_update_enabled: enabled, auto_update_hour: hour },
      });
      res.json({ data: { auto_update_enabled: enabled, auto_update_hour: hour } });
    }),
  );

  return router;
}
