import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError, type MachineDto, type ProjectRole } from '@devdeck/shared';
import {
  asyncHandler,
  clientIp,
  optionalString,
  param,
  requireConfirmation,
} from '../http.js';
import type { AppContext } from '../context.js';
import { getProjectMembership, requireUser, type MachineRecord } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { audit } from '../services/audit.js';

function toMachineDto(row: MachineRecord): MachineDto {
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    platform: row.platform,
    agent_version: row.agent_version,
    agent_status: row.revoked_at ? 'revoked' : (row.agent_status as MachineDto['agent_status']),
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

const MACHINE_COLUMNS = `id, owner_user_id, name, platform, agent_version, agent_status,
                         last_seen_at, token_hash, revoked_at, created_at`;

/** Machine Registry: Enrollment-Tokens, Übersicht, Widerruf (Spezifikation §15). */
export function machineRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  // Enrollment-Token erzeugen (einmalig, ablaufend, gehasht gespeichert)
  router.post(
    '/enrollment-tokens',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const projectId = optionalString(req.body, 'project_id', 64);
      const ttlMinutes = Math.min(Number(req.body?.ttl_minutes ?? 60) || 60, 24 * 60);

      if (projectId) {
        const role = getProjectMembership(db, projectId, user.id);
        const effective: ProjectRole | null =
          role ?? (user.system_role === 'admin' ? 'owner' : null);
        if (!effective || (effective !== 'owner' && effective !== 'maintainer')) {
          throw new AppError('FORBIDDEN', 'Nur Owner/Maintainer dürfen Enrollment-Tokens erzeugen');
        }
        if (!db.get('SELECT id FROM projects WHERE id = ?', projectId)) {
          throw new AppError('NOT_FOUND', 'Projekt nicht gefunden');
        }
      } else if (user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Ohne project_id ist nur admin berechtigt');
      }

      const token = generateToken();
      const now = new Date();
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
      db.run(
        `INSERT INTO enrollment_tokens (id, token_hash, created_by, project_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        hashToken(token),
        user.id,
        projectId,
        expiresAt,
        now.toISOString(),
      );
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.enrollment_token.create',
        project_id: projectId,
        target_type: 'enrollment_token',
        target_id: id,
        result: 'success',
        detail: { ttl_minutes: ttlMinutes },
        ip: clientIp(req),
      });
      // Einmaliges Plaintext-Token – wird nie gespeichert
      res.status(201).json({ data: { id, token, expires_at: expiresAt } });
    }),
  );

  // Machine-Übersicht: global (admin) oder projektbezogen (Mitglied)
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;

      if (projectId) {
        const role = getProjectMembership(db, projectId, user.id);
        const isAdmin = user.system_role === 'admin';
        if (!role && !isAdmin) throw new AppError('FORBIDDEN', 'Kein Zugriff auf dieses Projekt');
        const rows = db.all<MachineRecord>(
          `SELECT ${MACHINE_COLUMNS} FROM machines
           WHERE owner_user_id IN (SELECT user_id FROM project_members WHERE project_id = ?)
           ORDER BY name`,
          projectId,
        );
        res.json({ data: rows.map(toMachineDto) });
        return;
      }
      if (user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Globale Machine-Liste nur für admin');
      }
      const rows = db.all<MachineRecord>(
        `SELECT ${MACHINE_COLUMNS} FROM machines ORDER BY name`,
      );
      res.json({ data: rows.map(toMachineDto) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const row = db.get<MachineRecord>(
        `SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`,
        id,
      );
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        const member = db.get(
          `SELECT 1 AS x FROM project_members WHERE user_id = ? AND project_id IN
           (SELECT project_id FROM workspaces WHERE machine_id = ?)`,
          user.id,
          id,
        );
        if (!member) throw new AppError('FORBIDDEN', 'Kein Zugriff auf diese Maschine');
      }
      res.json({ data: toMachineDto(row) });
    }),
  );

  // Widerruf: Agent-Credentials müssen widerrufbar sein (Spec §28)
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      requireConfirmation(req.body);
      const row = db.get<MachineRecord>(
        `SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`,
        id,
      );
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf widerrufen');
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        db.run('UPDATE machines SET revoked_at = ?, agent_status = ? WHERE id = ?', now, 'offline', id);
        db.run(
          `UPDATE agent_commands SET status = 'expired', finished_at = ?, error = 'machine revoked'
           WHERE machine_id = ? AND status IN ('queued', 'running')`,
          now,
          id,
        );
        db.run(
          `UPDATE workspaces SET status = 'offline', updated_at = ? WHERE machine_id = ?`,
          now,
          id,
        );
      });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.revoke',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        ip: clientIp(req),
      });
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}
