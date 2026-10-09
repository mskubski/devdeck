import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  AppError,
  type MemberDto,
  type ProjectDto,
  type ProjectRole,
  isProjectRole,
} from '@devdeck/shared';
import {
  asyncHandler,
  clientIp,
  optionalString,
  param,
  requireConfirmation,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import {
  getProjectMembership,
  loadProject,
  requireProjectRole,
  requireSystemRole,
  type ProjectRecord,
} from '../auth/middleware.js';
import { slugify } from '../auth/tokens.js';
import { audit } from '../services/audit.js';

function toProjectDto(p: ProjectRecord, role?: ProjectRole): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    repo_remote: p.repo_remote,
    default_branch: p.default_branch,
    created_at: p.created_at,
    archived_at: p.archived_at,
    ...(role ? { role } : {}),
  };
}

export function projectRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const rows =
        user.system_role === 'admin'
          ? db.all<ProjectRecord & { role: string | null }>(
              `SELECT p.*, m.role FROM projects p
               LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
               ORDER BY p.name`,
              user.id,
            )
          : db.all<ProjectRecord & { role: string | null }>(
              `SELECT p.*, m.role FROM projects p
               JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
               ORDER BY p.name`,
              user.id,
            );
      res.json({
        data: rows.map((p) =>
          toProjectDto(
            p,
            (p.role as ProjectRole | null) ??
              (user.system_role === 'admin' ? 'owner' : undefined),
          ),
        ),
      });
    }),
  );

  router.post(
    '/',
    requireSystemRole('admin'),
    asyncHandler(async (req, res) => {
      const name = requireString(req.body, 'name').trim();
      const description = optionalString(req.body, 'description', 4000);
      const repoRemote = optionalString(req.body, 'repo_remote', 500);
      const defaultBranch = optionalString(req.body, 'default_branch', 100) ?? 'main';

      let slug = slugify(optionalString(req.body, 'slug') ?? name);
      if (db.get('SELECT id FROM projects WHERE slug = ?', slug)) {
        slug = `${slug}-${randomUUID().slice(0, 8)}`;
      }

      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: randomUUID(),
        name,
        slug,
        description,
        repo_remote: repoRemote,
        default_branch: defaultBranch,
        created_at: now,
        updated_at: now,
        archived_at: null,
      };
      db.transaction(() => {
        db.run(
          `INSERT INTO projects (id, name, slug, description, repo_remote, default_branch, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          project.id,
          project.name,
          project.slug,
          project.description,
          project.repo_remote,
          project.default_branch,
          project.created_at,
          project.updated_at,
        );
        db.run(
          'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
          project.id,
          req.user!.id,
          'owner',
          now,
        );
      });

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'project.create',
        project_id: project.id,
        target_type: 'project',
        target_id: project.id,
        result: 'success',
        detail: { name, slug },
        ip: clientIp(req),
      });
      res.status(201).json({ data: toProjectDto(project, 'owner') });
    }),
  );

  router.get(
    '/:projectId',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({ data: toProjectDto(req.project!, req.projectRole) });
    }),
  );

  router.patch(
    '/:projectId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const project = req.project!;
      const name = optionalString(req.body, 'name', 200)?.trim() || null;
      const description = optionalString(req.body, 'description', 4000);
      const repoRemote = optionalString(req.body, 'repo_remote', 500);
      const defaultBranch = optionalString(req.body, 'default_branch', 100);
      const archived = req.body?.archived;

      if (archived === true) requireConfirmation(req.body);

      db.run(
        `UPDATE projects SET
           name = COALESCE(?, name),
           description = COALESCE(?, description),
           repo_remote = COALESCE(?, repo_remote),
           default_branch = COALESCE(?, default_branch),
           archived_at = CASE WHEN ? THEN ? ELSE NULL END,
           updated_at = ?
         WHERE id = ?`,
        name,
        description,
        repoRemote,
        defaultBranch,
        archived === true,
        archived === true ? new Date().toISOString() : null,
        new Date().toISOString(),
        project.id,
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: archived === true ? 'project.archive' : 'project.update',
        project_id: project.id,
        target_type: 'project',
        target_id: project.id,
        result: 'success',
        ip: clientIp(req),
      });

      const updated = loadProject(db, project.id)!;
      res.json({ data: toProjectDto(updated, req.projectRole) });
    }),
  );

  router.get(
    '/:projectId/members',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const members = db.all<{
        user_id: string;
        email: string;
        display_name: string | null;
        role: ProjectRole;
        created_at: string;
      }>(
        `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
         FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ? ORDER BY u.email`,
        req.project!.id,
      );
      const dto: MemberDto[] = members.map((m) => ({
        user_id: m.user_id,
        email: m.email,
        display_name: m.display_name,
        role: m.role,
        created_at: m.created_at,
      }));
      res.json({ data: dto });
    }),
  );

  router.post(
    '/:projectId/members',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const email = requireString(req.body, 'email').trim().toLowerCase();
      const role = req.body?.role ?? 'developer';
      if (!isProjectRole(role)) {
        throw new AppError('VALIDATION', 'Ungültige Projektrolle');
      }
      const user = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (!user) throw new AppError('NOT_FOUND', 'Benutzer nicht gefunden');

      const existing = getProjectMembership(db, req.project!.id, user.id);
      if (existing) throw new AppError('CONFLICT', 'Benutzer ist bereits Mitglied');

      db.run(
        'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        req.project!.id,
        user.id,
        role,
        new Date().toISOString(),
      );
      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'project.membership.add',
        project_id: req.project!.id,
        target_type: 'user',
        target_id: user.id,
        result: 'success',
        detail: { role },
        ip: clientIp(req),
      });
      res.status(201).json({ data: { user_id: user.id, role } });
    }),
  );

  router.delete(
    '/:projectId/members/:userId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const projectId = param(req, 'projectId')!;
      const userId = param(req, 'userId')!;
      const role = getProjectMembership(db, projectId, userId);
      if (!role) throw new AppError('NOT_FOUND', 'Mitgliedschaft nicht gefunden');

      if (role === 'owner') {
        const owners = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'`,
          projectId,
        );
        if ((owners?.n ?? 0) <= 1) {
          throw new AppError('CONFLICT', 'Letzter Owner kann nicht entfernt werden');
        }
      }

      db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'project.membership.remove',
        project_id: projectId,
        target_type: 'user',
        target_id: userId,
        result: 'success',
        ip: clientIp(req),
      });
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}
