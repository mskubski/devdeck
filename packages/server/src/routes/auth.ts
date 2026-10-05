import { Router } from 'express';
import { AppError, type UserDto } from '@devdeck/shared';
import {
  asyncHandler,
  bearerToken,
  clientIp,
  parseCookies,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import { verifyPassword } from '../auth/passwords.js';
import { createSession, revokeSession } from '../auth/sessions.js';
import { SESSION_COOKIE, requireUser, type UserRecord } from '../auth/middleware.js';
import { audit } from '../services/audit.js';

export function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    system_role: user.system_role,
    disabled: Boolean(user.disabled),
    created_at: user.created_at,
  };
}

export function authRoutes(ctx: AppContext): Router {
  const { db, config } = ctx;
  const router = Router();

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const email = requireString(req.body, 'email').trim().toLowerCase();
      const password = requireString(req.body, 'password');
      const user = db.get<UserRecord>(
        `SELECT id, email, password_hash, system_role, display_name, created_at, updated_at, disabled
         FROM users WHERE email = ?`,
        email,
      );
      const valid =
        Boolean(user) &&
        !user!.disabled &&
        verifyPassword(password, user!.password_hash);

      audit(db, {
        actor_type: 'user',
        actor_id: user?.id ?? null,
        actor_label: email,
        action: 'auth.login',
        result: valid ? 'success' : 'failure',
        ip: clientIp(req),
      });

      if (!valid) {
        // Kein Unterscheidungssignal zwischen „unbekannt" und „falsch".
        throw new AppError('UNAUTHORIZED', 'Ungültige Anmeldedaten');
      }

      const { token } = createSession(db, user!.id, config.sessionTtlMs, {
        user_agent: req.headers['user-agent'] ?? null,
        ip: clientIp(req),
      });

      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.secureCookies,
        path: '/',
        maxAge: config.sessionTtlMs,
      });
      res.json({ data: toUserDto(user!) });
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = parseCookies(req)[SESSION_COOKIE] ?? bearerToken(req);
      if (token) revokeSession(db, token);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ data: { ok: true } });
    }),
  );

  router.get(
    '/me',
    requireUser(db),
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const memberships = db.all<{ project_id: string; role: string; name: string; slug: string }>(
        `SELECT m.project_id, m.role, p.name, p.slug
         FROM project_members m JOIN projects p ON p.id = m.project_id
         WHERE m.user_id = ? ORDER BY p.name`,
        user.id,
      );
      res.json({
        data: {
          user: toUserDto(user),
          memberships: memberships.map((m) => ({
            project_id: m.project_id,
            role: m.role,
            name: m.name,
            slug: m.slug,
          })),
        },
      });
    }),
  );

  return router;
}
