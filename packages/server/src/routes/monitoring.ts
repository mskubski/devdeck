import { Router, type Request } from 'express';
import { AppError } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, clientIp, param, requireConfirmation } from '../http.js';
import { getProjectMembership, requireUser } from '../auth/middleware.js';
import {
  checkNow, createMonitor, deleteMonitor, getMonitor, monitorDtos, projectMonitoring, updateMonitor, visibleMonitors, type MonitorInput,
} from '../services/monitoring.js';
import { applySuggestions, suggestMonitors, suggestSystemMonitors } from '../services/monitoringSuggest.js';

/**
 * Monitoring (Menü „Monitoring“): Monitore ansehen (Mitglieder des Projekts, Admin alles), anlegen/ändern (Projekt-Maintainer, System-Monitore nur Admin).
 */
export function monitoringRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  const actorOf = (req: Request) => ({ id: req.user!.id, label: req.user!.email, isAdmin: req.user!.system_role === 'admin', ip: clientIp(req) });

  /** Verwalten dürfen Admins sowie Maintainer/Owner des Projekts (System-Monitore ohne Projekt nur Admins). */
  const assertManage = (req: Request, projectId: string | null): void => {
    const user = req.user!;
    if (user.system_role === 'admin') return;
    const role = projectId ? getProjectMembership(db, projectId, user.id) : null;
    if (role !== 'maintainer' && role !== 'owner') throw new AppError('FORBIDDEN', projectId ? 'Monitore verwalten dürfen Maintainer und Owner des Projekts' : 'System-Monitore darf nur ein Administrator verwalten');
  };
  const monitorOf = (req: Request) => {
    const m = getMonitor(ctx, param(req, 'monitorId')!);
    if (!m) throw new AppError('NOT_FOUND', 'Monitor nicht gefunden');
    // wer ihn nicht sehen darf, erfährt nicht einmal, dass er existiert
    if (req.user!.system_role !== 'admin' && (!m.project_id || !getProjectMembership(db, m.project_id, req.user!.id))) throw new AppError('NOT_FOUND', 'Monitor nicht gefunden');
    return m;
  };

  router.get(
    '/monitoring',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const projectId = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
      const rows = visibleMonitors(ctx, user, projectId);
      const dtos = monitorDtos(ctx, rows);
      const projects = user.system_role === 'admin'
        ? db.all<{ id: string; name: string }>('SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY name')
        : db.all<{ id: string; name: string }>('SELECT p.id, p.name FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.deleted_at IS NULL ORDER BY p.name', user.id);
      const manageable = user.system_role === 'admin'
        ? projects.map((p) => p.id)
        : db.all<{ project_id: string }>(`SELECT project_id FROM project_members WHERE user_id = ? AND role IN ('maintainer','owner')`, user.id).map((r) => r.project_id);
      const eff = dtos.filter((d) => d.enabled);
      res.json({
        data: {
          monitors: dtos,
          projects: projects.map((p) => ({ ...p, can_manage: manageable.includes(p.id), monitoring: projectMonitoring(ctx, [p.id]).get(p.id) })),
          can_manage_system: user.system_role === 'admin',
          summary: {
            total: eff.length,
            ok: eff.filter((d) => d.effective_status === 'ok').length,
            warn: eff.filter((d) => d.effective_status === 'warn').length,
            error: eff.filter((d) => d.effective_status === 'error').length,
            unknown: eff.filter((d) => d.effective_status === 'unknown').length,
          },
          machines: db.all<{ id: string; name: string; platform: string; agent_status: string }>('SELECT id, name, platform, agent_status FROM machines WHERE revoked_at IS NULL ORDER BY name'),
          jobs: db.all<{ id: string; name: string; project_id: string }>('SELECT id, name, project_id FROM backup_jobs ORDER BY name').filter((j) => manageable.includes(j.project_id)),
          connectors: db.all<{ id: string; name: string; type: string; project_id: string }>('SELECT id, name, type, project_id FROM project_connectors').filter((c) => manageable.includes(c.project_id)),
        },
      });
    }),
  );

  router.post(
    '/monitors',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as MonitorInput;
      const projectId = typeof body.project_id === 'string' && body.project_id ? body.project_id : null;
      assertManage(req, projectId);
      const m = await createMonitor(ctx, body, actorOf(req));
      // sofort einmal prüfen, damit der Monitor nicht erst „unbekannt“ zeigt
      const fresh = await checkNow(ctx, m.id).catch(() => m);
      res.status(201).json({ data: monitorDtos(ctx, [fresh])[0] });
    }),
  );

  router.get(
    '/monitors/suggestions',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.query.project_id === 'string' && req.query.project_id ? req.query.project_id : null;
      assertManage(req, projectId);
      const list = projectId ? suggestMonitors(ctx, projectId) : suggestSystemMonitors(ctx);
      const have = new Set(db.all<{ auto_key: string }>('SELECT auto_key FROM monitors WHERE COALESCE(project_id, \'\') = ? AND auto_key IS NOT NULL', projectId ?? '').map((r) => r.auto_key));
      res.json({ data: list.map((s) => ({ auto_key: s.auto_key, name: s.name, kind: s.kind, environment: s.environment, group: s.group, reason: s.reason, exists: have.has(s.auto_key) })) });
    }),
  );

  router.post(
    '/monitors/seed',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.body?.project_id === 'string' && req.body.project_id ? (req.body.project_id as string) : null;
      assertManage(req, projectId);
      res.json({ data: await applySuggestions(ctx, projectId, actorOf(req)) });
    }),
  );

  router.patch(
    '/monitors/:monitorId',
    asyncHandler(async (req, res) => {
      const m = monitorOf(req);
      assertManage(req, m.project_id);
      const updated = await updateMonitor(ctx, m.id, (req.body ?? {}) as MonitorInput, actorOf(req));
      const fresh = await checkNow(ctx, updated.id).catch(() => updated);
      res.json({ data: monitorDtos(ctx, [fresh])[0] });
    }),
  );

  router.delete(
    '/monitors/:monitorId',
    asyncHandler(async (req, res) => {
      const m = monitorOf(req);
      assertManage(req, m.project_id);
      requireConfirmation(req.body);
      deleteMonitor(ctx, m.id, actorOf(req));
      res.status(204).end();
    }),
  );

  router.post(
    '/monitors/:monitorId/check',
    asyncHandler(async (req, res) => {
      const m = monitorOf(req);
      assertManage(req, m.project_id);
      res.json({ data: monitorDtos(ctx, [await checkNow(ctx, m.id)])[0] });
    }),
  );

  return router;
}
