import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError, type SystemRole, type UserDto } from '@devdeck/shared';
import {
  asyncHandler,
  clientIp,
  optionalString,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import { hashPassword } from '../auth/passwords.js';
import { revokeAllUserSessions } from '../auth/sessions.js';
import { requireSystemRole, type UserRecord } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { toUserDto } from './auth.js';

/** Benuterverwaltung – ausschließlich Systemrolle admin. */
export function userRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();

  router.use(requireSystemRole('admin'));

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const users = db.all<UserRecord>(
        `SELECT id, email, password_hash, system_role, display_name, created_at, updated_at, disabled
         FROM users ORDER BY created_at`,
      );
      res.json({ data: users.map(toUserDto) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const email = requireString(req.body, 'email').trim().toLowerCase();
      const password = requireString(req.body, 'password');
      const systemRole = (optionalString(req.body, 'system_role') ?? 'developer') as SystemRole;
      if (systemRole !== 'admin' && systemRole !== 'developer') {
        throw new AppError('VALIDATION', 'system_role muss admin oder developer sein');
      }
      const displayName = optionalString(req.body, 'display_name', 120);

      const existing = db.get('SELECT id FROM users WHERE email = ?', email);
      if (existing) {
        throw new AppError('CONFLICT', 'E-Mail-Adresse bereits vergeben');
      }

      const now = new Date().toISOString();
      const user: UserRecord = {
        id: randomUUID(),
        email,
        password_hash: hashPassword(password),
        system_role: systemRole,
        display_name: displayName,
        created_at: now,
        updated_at: now,
        disabled: 0,
      };
      db.run(
        `INSERT INTO users (id, email, password_hash, system_role, display_name, created_at, updated_at, disabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        user.id,
        user.email,
        user.password_hash,
        user.system_role,
        user.display_name,
        user.created_at,
        user.updated_at,
      );
      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'user.create',
        target_type: 'user',
        target_id: user.id,
        result: 'success',
        detail: { email, system_role: systemRole },
        ip: clientIp(req),
      });
      res.status(201).json({ data: toUserDto(user) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const target = db.get<UserRecord>(
        `SELECT id, email, password_hash, system_role, display_name, created_at, updated_at, disabled
         FROM users WHERE id = ?`,
        req.params.id,
      );
      if (!target) throw new AppError('NOT_FOUND', 'Benutzer nicht gefunden');

      const disabled = req.body?.disabled;
      const systemRole = optionalString(req.body, 'system_role');
      const password = optionalString(req.body, 'password', 512);
      const displayName = optionalString(req.body, 'display_name', 120);

      if (systemRole && systemRole !== 'admin' && systemRole !== 'developer') {
        throw new AppError('VALIDATION', 'system_role muss admin oder developer sein');
      }

      // Niemals den letzten aktivierten Admin degradieren/sperrern.
      if ((disabled === true || systemRole === 'developer') && target.system_role === 'admin') {
        const activeAdmins = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM users
           WHERE system_role = 'admin' AND disabled = 0 AND id <> ?`,
          target.id,
        );
        if ((activeAdmins?.n ?? 0) === 0) {
          throw new AppError('CONFLICT', 'Letzter aktiver Admin kann nicht gesperrt/degradiert werden');
        }
      }

      db.run(
        `UPDATE users SET
           system_role = COALESCE(?, system_role),
           display_name = COALESCE(?, display_name),
           password_hash = COALESCE(?, password_hash),
           disabled = COALESCE(?, disabled),
           updated_at = ?
         WHERE id = ?`,
        systemRole ?? null,
        displayName ?? null,
        password ? hashPassword(password) : null,
        disabled === undefined ? null : disabled ? 1 : 0,
        new Date().toISOString(),
        target.id,
      );

      if (disabled === true || password) {
        revokeAllUserSessions(db, target.id);
      }

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'user.update',
        target_type: 'user',
        target_id: target.id,
        result: 'success',
        detail: { disabled: disabled === true, role_changed: Boolean(systemRole), password_changed: Boolean(password) },
        ip: clientIp(req),
      });

      const updated = db.get<UserRecord>(
        `SELECT id, email, password_hash, system_role, display_name, created_at, updated_at, disabled
         FROM users WHERE id = ?`,
        target.id,
      )!;
      const dto: UserDto = toUserDto(updated);
      res.json({ data: dto });
    }),
  );

  return router;
}
