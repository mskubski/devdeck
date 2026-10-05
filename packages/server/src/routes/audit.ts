import { Router } from 'express';
import type { AuditEntryDto } from '@devdeck/shared';
import { AppError } from '@devdeck/shared';
import { asyncHandler, optionalString } from '../http.js';
import type { AppContext } from '../context.js';
import { requireSystemRole } from '../auth/middleware.js';

function toAuditDto(row: Record<string, unknown>): AuditEntryDto {
  return {
    id: row.id as string,
    actor_type: row.actor_type as string,
    actor_label: (row.actor_label as string | null) ?? null,
    action: row.action as string,
    project_id: (row.project_id as string | null) ?? null,
    machine_id: (row.machine_id as string | null) ?? null,
    target_type: (row.target_type as string | null) ?? null,
    target_id: (row.target_id as string | null) ?? null,
    result: row.result as AuditEntryDto['result'],
    detail_json: (row.detail_json as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

/** Audit-Log-Endpunkte (Spezifikation §25): nie Secret-Values. */
export function auditRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const projectId = optionalString(req.query, 'project_id', 64);
      const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);

      // Admin: alles. Sonst: nur eigene Projekte (Membership erforderlich).
      if (user.system_role === 'admin') {
        const rows = projectId
          ? db.all(
              `SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
              projectId,
              limit,
            )
          : db.all(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`, limit);
        res.json({ data: rows.map(toAuditDto) });
        return;
      }

      if (!projectId) {
        throw new AppError('BAD_REQUEST', 'project_id ist für Nicht-Admins erforderlich');
      }
      const member = db.get(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        projectId,
        user.id,
      );
      if (!member) throw new AppError('FORBIDDEN', 'Kein Zugriff auf dieses Projekt');

      const rows = db.all(
        `SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
        projectId,
        limit,
      );
      res.json({ data: rows.map(toAuditDto) });
    }),
  );

  // Zusätzlich: Admin-Endpunkt für rollenweite Auswertung
  router.get(
    '/all',
    requireSystemRole('admin'),
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
      const rows = db.all(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`, limit);
      res.json({ data: rows.map(toAuditDto) });
    }),
  );

  return router;
}
