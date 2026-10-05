import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  AppError,
  type ProjectRole,
  type SecretCapability,
  type SystemRole,
  implicitSecretCapabilities,
  isSecretCapability,
} from '@devdeck/shared';
import type { Database } from '../db/database.js';
import { bearerToken, param, parseCookies } from '../http.js';
import { findValidSession } from './sessions.js';
import { hashToken } from './tokens.js';

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  system_role: SystemRole;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  disabled: number;
}

export interface MachineRecord {
  id: string;
  owner_user_id: string;
  name: string;
  platform: string;
  agent_version: string | null;
  agent_status: string;
  last_seen_at: string | null;
  token_hash: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repo_remote: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRecord;
    machine?: MachineRecord;
    project?: ProjectRecord;
    projectRole?: ProjectRole;
  }
}

export const SESSION_COOKIE = 'dd_session';

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 0,
  developer: 1,
  maintainer: 2,
  owner: 3,
};

/** Holt den authentifizierten Benutzer (Session-Cookie ODER Bearer-Token der CLI). */
export function currentUser(req: Request, db: Database): UserRecord | null {
  const cookieToken = parseCookies(req)[SESSION_COOKIE];
  const token = cookieToken ?? bearerToken(req);
  if (!token) return null;
  const session = findValidSession(db, token);
  if (!session) return null;
  const user = db.get<UserRecord>(
    `SELECT id, email, password_hash, system_role, display_name, created_at, updated_at, disabled
     FROM users WHERE id = ?`,
    session.user_id,
  );
  if (!user || user.disabled) return null;
  return user;
}

/** Require: angemeldeter, nicht gesperrter Benutzer. */
export function requireUser(db: Database): RequestHandler {
  return (req, _res, next) => {
    const user = currentUser(req, db);
    if (!user) {
      next(new AppError('UNAUTHORIZED', 'Anmeldung erforderlich'));
      return;
    }
    req.user = user;
    next();
  };
}

/** Require: Systemrolle (admin|developer) – unabhängig von Projektrollen. */
export function requireSystemRole(...roles: SystemRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(new AppError('UNAUTHORIZED', 'Anmeldung erforderlich'));
      return;
    }
    if (!roles.includes(user.system_role)) {
      next(new AppError('FORBIDDEN', 'Systemrolle nicht ausreichend'));
      return;
    }
    next();
  };
}

export function getProjectMembership(
  db: Database,
  projectId: string,
  userId: string,
): ProjectRole | null {
  const row = db.get<{ role: ProjectRole }>(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    userId,
  );
  return row?.role ?? null;
}

export function loadProject(db: Database, projectId: string): ProjectRecord | null {
  return (
    db.get<ProjectRecord>(
      `SELECT id, name, slug, description, repo_remote, default_branch,
              created_at, updated_at, archived_at
       FROM projects WHERE id = ?`,
      projectId,
    ) ?? null
  );
}

/**
 * Require: Projekt-Mitgliedschaft mind. der Mindestrolle.
 * Admins ohne Membership erhalten Owner-Rechte (dokumentiert in PLAN A13/§9).
 */
export function requireProjectRole(db: Database, min: ProjectRole): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(new AppError('UNAUTHORIZED', 'Anmeldung erforderlich'));
      return;
    }
    const projectId = param(req, 'projectId') ?? param(req, 'id');
    if (!projectId) {
      next(new AppError('BAD_REQUEST', 'Projekt-ID fehlt'));
      return;
    }
    const project = loadProject(db, projectId);
    if (!project) {
      next(new AppError('NOT_FOUND', 'Projekt nicht gefunden'));
      return;
    }
    const membership = getProjectMembership(db, projectId, user.id);
    let effective: ProjectRole | null = membership;
    if (user.system_role === 'admin') effective = effective ?? 'owner';
    if (!effective || ROLE_RANK[effective] < ROLE_RANK[min]) {
      next(new AppError('FORBIDDEN', 'Keine ausreichenden Projektrechte'));
      return;
    }
    req.project = project;
    req.projectRole = effective;
    next();
  };
}

/** Secret-Capability-Menge inkl. expliziter Grants/Denials (Entscheidung A13). */
export function secretCapabilitiesFor(
  db: Database,
  secretId: string,
  userId: string,
  role: ProjectRole,
): Set<SecretCapability> {
  const caps = new Set<SecretCapability>(implicitSecretCapabilities(role));
  const grants = db.all<{ capability: string }>(
    `SELECT capability FROM secret_grants
     WHERE secret_id = ? AND ((subject_type = 'user' AND subject_id = ?)
                           OR (subject_type = 'role' AND subject_id = ?))`,
    secretId,
    userId,
    role,
  );
  for (const grant of grants) {
    if (isSecretCapability(grant.capability)) caps.add(grant.capability);
  }
  const denials = db.all<{ capability: string }>(
    `SELECT capability FROM secret_grants
     WHERE secret_id = ? AND subject_type = 'user' AND subject_id = ?
       AND capability LIKE 'deny:%'`,
    secretId,
    userId,
  );
  for (const denial of denials) {
    const cap = denial.capability.slice(5);
    if (isSecretCapability(cap)) caps.delete(cap);
  }
  return caps;
}

/** Require: Secret-Capability für das Secret in :secretId bzw. :id. */
export function requireSecretCapability(db: Database, capability: SecretCapability): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(new AppError('UNAUTHORIZED', 'Anmeldung erforderlich'));
      return;
    }
    const secretId = param(req, 'secretId') ?? param(req, 'id');
    const projectId = param(req, 'projectId');
    if (!secretId || !projectId) {
      next(new AppError('BAD_REQUEST', 'Secret-ID oder Projekt-ID fehlt'));
      return;
    }
    const secret = db.get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM secrets WHERE id = ?',
      secretId,
    );
    if (!secret || secret.project_id !== projectId) {
      next(new AppError('NOT_FOUND', 'Secret nicht gefunden'));
      return;
    }
    const role = getProjectMembership(db, projectId, user.id);
    const effectiveRole: ProjectRole =
      role ?? (user.system_role === 'admin' ? 'owner' : 'viewer');
    const caps = secretCapabilitiesFor(db, secretId, user.id, effectiveRole);
    if (!caps.has(capability)) {
      next(new AppError('FORBIDDEN', `Capability ${capability} nicht vergeben`));
      return;
    }
    req.projectRole = effectiveRole;
    next();
  };
}

/** Require: gültiges, nicht widerrufenes Maschinen-Token (Agent-Protokoll). */
export function requireAgent(db: Database): RequestHandler {
  return (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) {
      next(new AppError('UNAUTHORIZED', 'Agent-Token erforderlich'));
      return;
    }
    const machine = db.get<MachineRecord>(
      `SELECT id, owner_user_id, name, platform, agent_version, agent_status,
              last_seen_at, token_hash, revoked_at, created_at
       FROM machines WHERE token_hash = ?`,
      hashToken(token),
    );
    if (!machine) {
      next(new AppError('UNAUTHORIZED', 'Ungültiger Agent-Token'));
      return;
    }
    if (machine.revoked_at) {
      next(new AppError('UNAUTHORIZED', 'Agent-Token widerrufen'));
      return;
    }
    req.machine = machine;
    next();
  };
}
