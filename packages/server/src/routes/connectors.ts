import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, clientIp, param, requireString } from '../http.js';
import { requireProjectRole, requireUser, secretCapabilitiesFor } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { getConnector, listConnectors } from '../services/connectors/index.js';

interface ConnectorRow {
  id: string;
  project_id: string;
  type: string;
  name: string;
  config_json: string;
  secret_id: string | null;
  last_check_at: string | null;
  last_check_ok: number | null;
  last_check_message: string | null;
  created_at: string;
}

function toDto(row: ConnectorRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    name: row.name,
    config: JSON.parse(row.config_json) as Record<string, string>,
    secret_id: row.secret_id,
    last_check_at: row.last_check_at,
    last_check_ok: row.last_check_ok === null ? null : Boolean(row.last_check_ok),
    last_check_message: row.last_check_message,
    created_at: row.created_at,
  };
}

/** Phase J: Service-Integrationen. Credentials liegen im Vault und werden nur serverseitig genutzt. */
export function connectorRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  router.get('/connector-types', (_req, res) => {
    res.json({ data: listConnectors().map((c) => ({ type: c.type, label: c.label, fields: c.fields })) });
  });

  router.get(
    '/projects/:projectId/connectors',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const rows = db.all<ConnectorRow>(
        'SELECT * FROM project_connectors WHERE project_id = ? ORDER BY created_at',
        req.project!.id,
      );
      res.json({ data: rows.map(toDto) });
    }),
  );

  router.post(
    '/projects/:projectId/connectors',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const type = requireString(req.body, 'type');
      const connector = getConnector(type);
      if (!connector) throw new AppError('VALIDATION', `Unbekannter Konnektor-Typ: ${type}`);
      const name = requireString(req.body, 'name').trim();
      const secretId = requireString(req.body, 'secret_id');

      let config: Record<string, string>;
      try {
        config = connector.validateConfig((req.body?.config ?? {}) as Record<string, unknown>);
      } catch (err) {
        throw new AppError('VALIDATION', err instanceof Error ? err.message : 'Ungültige Konfiguration');
      }

      const secret = db.get<{ id: string }>('SELECT id FROM secrets WHERE id = ? AND project_id = ?', secretId, req.project!.id);
      if (!secret) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      // Wer einen Konnektor anlegt, muss das Secret selbst nutzen dürfen
      if (!secretCapabilitiesFor(db, secretId, req.user!.id, req.projectRole!).has('secret.use')) {
        throw new AppError('FORBIDDEN', 'Capability secret.use für dieses Secret fehlt');
      }
      if (db.get('SELECT 1 FROM project_connectors WHERE project_id = ? AND name = ?', req.project!.id, name)) {
        throw new AppError('CONFLICT', `Konnektor "${name}" existiert bereits`);
      }

      const id = randomUUID();
      db.run(
        `INSERT INTO project_connectors (id, project_id, type, name, config_json, secret_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        req.project!.id,
        type,
        name,
        JSON.stringify(config),
        secretId,
        req.user!.id,
        new Date().toISOString(),
      );
      audit(db, {
        actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email,
        action: 'connector.create', project_id: req.project!.id,
        target_type: 'connector', target_id: id, result: 'success',
        detail: { type, name, secret_id: secretId }, ip: clientIp(req),
      });
      res.status(201).json({ data: toDto(db.get<ConnectorRow>('SELECT * FROM project_connectors WHERE id = ?', id)!) });
    }),
  );

  router.post(
    '/projects/:projectId/connectors/:connectorId/check',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'connectorId')!;
      const row = db.get<ConnectorRow>(
        'SELECT * FROM project_connectors WHERE id = ? AND project_id = ?',
        id,
        req.project!.id,
      );
      if (!row) throw new AppError('NOT_FOUND', 'Konnektor nicht gefunden');
      const connector = getConnector(row.type);
      if (!connector) throw new AppError('INTERNAL', `Konnektor-Typ nicht mehr verfügbar: ${row.type}`);
      if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist nicht initialisiert');
      const secret = row.secret_id
        ? db.get<{ vault_reference: string }>('SELECT vault_reference FROM secrets WHERE id = ?', row.secret_id)
        : undefined;
      if (!secret || !ctx.vault.has(secret.vault_reference)) {
        throw new AppError('SECRET_UNAVAILABLE', 'Für diesen Konnektor ist kein Credential-Wert im Vault hinterlegt');
      }

      const result = await connector.check({
        config: JSON.parse(row.config_json) as Record<string, string>,
        credential: ctx.vault.getString(secret.vault_reference),
        fetch: ctx.fetch ?? fetch,
      });
      db.run(
        'UPDATE project_connectors SET last_check_at = ?, last_check_ok = ?, last_check_message = ? WHERE id = ?',
        new Date().toISOString(),
        result.ok ? 1 : 0,
        result.message,
        id,
      );
      audit(db, {
        actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email,
        action: 'connector.check', project_id: req.project!.id,
        target_type: 'connector', target_id: id, result: result.ok ? 'success' : 'failure',
        detail: { type: row.type, message: result.message }, ip: clientIp(req),
      });
      res.json({
        data: { ...result, connector: toDto(db.get<ConnectorRow>('SELECT * FROM project_connectors WHERE id = ?', id)!) },
      });
    }),
  );

  router.delete(
    '/projects/:projectId/connectors/:connectorId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'connectorId')!;
      const r = db.run('DELETE FROM project_connectors WHERE id = ? AND project_id = ?', id, req.project!.id);
      if (r.changes === 0) throw new AppError('NOT_FOUND', 'Konnektor nicht gefunden');
      audit(db, {
        actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email,
        action: 'connector.delete', project_id: req.project!.id,
        target_type: 'connector', target_id: id, result: 'success', ip: clientIp(req),
      });
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}
