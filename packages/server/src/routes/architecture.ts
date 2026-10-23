import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError, isArchKind, type ArchDetail } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, clientIp, optionalString, param, requireString } from '../http.js';
import { requireProjectRole, requireUser } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { buildArchitecture } from '../services/architecture/build.js';
import { requestWorkspaceStatus } from '../services/provisioning.js';

/** Architektur-Karte: lesen (Viewer), anpassen (Maintainer), Fakten neu erheben (Developer). */
export function architectureRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  const keyOf = (req: Parameters<typeof param>[0]): string => {
    const key = param(req, 'key')!;
    if (!/^[A-Za-z0-9_.:@ -]{1,100}$/.test(key)) throw new AppError('VALIDATION', 'Ungültiger Schlüssel');
    return key;
  };

  const detailsOf = (body: unknown): ArchDetail[] | null => {
    const raw = (body as Record<string, unknown> | undefined)?.details;
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) throw new AppError('VALIDATION', 'details muss eine Liste sein');
    return raw.slice(0, 12).flatMap((d) =>
      d && typeof d.label === 'string' && typeof d.value === 'string' && d.label.trim()
        ? [{ label: d.label.trim().slice(0, 60), value: d.value.trim().slice(0, 300) }]
        : []);
  };

  router.get(
    '/projects/:projectId/architecture',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({ data: buildArchitecture(ctx, req.project!.id) });
    }),
  );

  // Komponente anlegen (ohne Schlüssel → neue manuelle Komponente)
  router.post(
    '/projects/:projectId/architecture/components',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const name = requireString(req.body, 'name').trim().slice(0, 120);
      const kind = req.body?.kind;
      if (!isArchKind(kind)) throw new AppError('VALIDATION', 'Ungültiger Typ (kind)');
      const key = `manual:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'komponente'}-${randomUUID().slice(0, 6)}`;
      db.run(
        `INSERT INTO arch_components (id, project_id, key, kind, name, provider, description, details_json, hidden, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        randomUUID(), req.project!.id, key, kind, name, optionalString(req.body, 'provider', 120),
        optionalString(req.body, 'description', 600), JSON.stringify(detailsOf(req.body) ?? []), req.user!.id, new Date().toISOString(),
      );
      audit(db, { actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email, action: 'architecture.component.create',
        project_id: req.project!.id, target_type: 'arch_component', target_id: key, result: 'success', detail: { name, kind }, ip: clientIp(req) });
      res.status(201).json({ data: { key } });
    }),
  );

  // Komponente anpassen (auch automatisch erkannte/aus dem Manifest) oder ausblenden
  router.put(
    '/projects/:projectId/architecture/components/:key',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const key = keyOf(req);
      const hidden = req.body?.hidden === true;
      const current = buildArchitecture(ctx, req.project!.id).components.find((c) => c.key === key);
      const existing = db.get<{ kind: string; name: string }>('SELECT kind, name FROM arch_components WHERE project_id = ? AND key = ?', req.project!.id, key);
      if (!current && !existing) throw new AppError('NOT_FOUND', 'Komponente nicht gefunden');
      const kind = req.body?.kind ?? current?.kind ?? existing?.kind;
      if (!isArchKind(kind)) throw new AppError('VALIDATION', 'Ungültiger Typ (kind)');
      const name = (req.body?.name ? requireString(req.body, 'name').trim() : current?.name ?? existing!.name).slice(0, 120);
      const details = detailsOf(req.body) ?? current?.details ?? [];
      db.run(
        `INSERT INTO arch_components (id, project_id, key, kind, name, provider, description, details_json, hidden, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET kind = excluded.kind, name = excluded.name, provider = excluded.provider,
           description = excluded.description, details_json = excluded.details_json, hidden = excluded.hidden,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        randomUUID(), req.project!.id, key, kind, name,
        req.body && 'provider' in req.body ? optionalString(req.body, 'provider', 120) : current?.provider ?? null,
        req.body && 'description' in req.body ? optionalString(req.body, 'description', 600) : current?.description ?? null,
        JSON.stringify(details), hidden ? 1 : 0, req.user!.id, new Date().toISOString(),
      );
      audit(db, { actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email, action: hidden ? 'architecture.component.hide' : 'architecture.component.update',
        project_id: req.project!.id, target_type: 'arch_component', target_id: key, result: 'success', detail: { name, kind }, ip: clientIp(req) });
      res.json({ data: { key } });
    }),
  );

  // Manuelle Anpassung entfernen (stellt bei automatisch erkannten Komponenten den Ursprungszustand wieder her)
  router.delete(
    '/projects/:projectId/architecture/components/:key',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const key = keyOf(req);
      const r = db.run('DELETE FROM arch_components WHERE project_id = ? AND key = ?', req.project!.id, key);
      if (r.changes === 0) throw new AppError('NOT_FOUND', 'Keine manuelle Anpassung vorhanden');
      db.run('DELETE FROM arch_links WHERE project_id = ? AND (from_key = ? OR to_key = ?) AND hidden = 0', req.project!.id, key, key);
      audit(db, { actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email, action: 'architecture.component.reset',
        project_id: req.project!.id, target_type: 'arch_component', target_id: key, result: 'success', ip: clientIp(req) });
      res.json({ data: { ok: true } });
    }),
  );

  // Beziehung hinzufügen
  router.post(
    '/projects/:projectId/architecture/links',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const from = requireString(req.body, 'from');
      const to = requireString(req.body, 'to');
      const label = requireString(req.body, 'label').trim().slice(0, 80);
      const keys = new Set(buildArchitecture(ctx, req.project!.id).components.map((c) => c.key));
      if (!keys.has(from) || !keys.has(to) || from === to) throw new AppError('VALIDATION', 'Start und Ziel müssen verschiedene, vorhandene Komponenten sein');
      db.run(
        `INSERT INTO arch_links (id, project_id, from_key, to_key, label, description, hidden, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(project_id, from_key, to_key, label) DO UPDATE SET description = excluded.description, hidden = 0,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        randomUUID(), req.project!.id, from, to, label, optionalString(req.body, 'description', 400), req.user!.id, new Date().toISOString(),
      );
      audit(db, { actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email, action: 'architecture.link.create',
        project_id: req.project!.id, target_type: 'arch_link', target_id: `${from}>${to}`, result: 'success', detail: { label }, ip: clientIp(req) });
      res.status(201).json({ data: { ok: true } });
    }),
  );

  // Beziehung entfernen: manuelle wird gelöscht, automatische/Manifest-Beziehung ausgeblendet
  router.delete(
    '/projects/:projectId/architecture/links',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const from = requireString(req.body, 'from');
      const to = requireString(req.body, 'to');
      const label = requireString(req.body, 'label');
      const manual = db.get<{ id: string }>(
        'SELECT id FROM arch_links WHERE project_id = ? AND from_key = ? AND to_key = ? AND label = ? AND hidden = 0',
        req.project!.id, from, to, label,
      );
      const stillThere = buildArchitecture(ctx, req.project!.id).links.some((l) => l.from === from && l.to === to && l.label === label);
      if (!stillThere) throw new AppError('NOT_FOUND', 'Beziehung nicht gefunden');
      if (manual) db.run('DELETE FROM arch_links WHERE id = ?', manual.id);
      // Gibt es sie danach weiterhin (automatisch/Manifest), ausblenden
      if (buildArchitecture(ctx, req.project!.id).links.some((l) => l.from === from && l.to === to && l.label === label)) {
        db.run(
          `INSERT INTO arch_links (id, project_id, from_key, to_key, label, description, hidden, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
           ON CONFLICT(project_id, from_key, to_key, label) DO UPDATE SET hidden = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          randomUUID(), req.project!.id, from, to, label, req.user!.id, new Date().toISOString(),
        );
      }
      audit(db, { actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email, action: 'architecture.link.remove',
        project_id: req.project!.id, target_type: 'arch_link', target_id: `${from}>${to}`, result: 'success', detail: { label }, ip: clientIp(req) });
      res.json({ data: { ok: true } });
    }),
  );

  // Ausgeblendetes wiederherstellen
  router.post(
    '/projects/:projectId/architecture/restore',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      if (req.body?.type === 'link') {
        const r = db.run(
          'DELETE FROM arch_links WHERE project_id = ? AND from_key = ? AND to_key = ? AND label = ? AND hidden = 1',
          req.project!.id, requireString(req.body, 'from'), requireString(req.body, 'to'), requireString(req.body, 'label'),
        );
        if (r.changes === 0) throw new AppError('NOT_FOUND', 'Keine ausgeblendete Beziehung');
      } else {
        const r = db.run('DELETE FROM arch_components WHERE project_id = ? AND key = ? AND hidden = 1', req.project!.id, requireString(req.body, 'key'));
        if (r.changes === 0) throw new AppError('NOT_FOUND', 'Keine ausgeblendete Komponente');
      }
      audit(db, { actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email, action: 'architecture.restore',
        project_id: req.project!.id, target_type: 'architecture', result: 'success', ip: clientIp(req) });
      res.json({ data: { ok: true } });
    }),
  );

  // Fakten neu erheben: alle Workspaces des Projekts prüfen lassen (Agent liefert dabei die Fakten mit)
  router.post(
    '/projects/:projectId/architecture/refresh',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const list = db.all<{ id: string; machine_id: string | null; local_path: string }>(
        'SELECT id, machine_id, local_path FROM workspaces WHERE project_id = ?', req.project!.id,
      );
      let requested = 0;
      for (const w of list) if (requestWorkspaceStatus(db, w, req.user!.id, true)) requested++;
      res.status(202).json({ data: { requested, workspaces: list.length } });
    }),
  );

  return router;
}
