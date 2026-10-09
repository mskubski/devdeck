import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { asyncHandler, clientIp, optionalString, param, requireString } from '../http.js';
import { requireProjectRole, requireUser } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { AppError } from '@devdeck/shared';
import type { TaskDto, TaskStatus } from '@devdeck/shared';

export function taskRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  // List tasks for a project
  router.get(
    '/projects/:projectId/tasks',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const tasks = db.all<TaskDto>(
        `SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
          t.created_by, t.created_at, t.updated_at, t.closed_at,
          u.email AS created_by_email
         FROM tasks t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.project_id = ?
         ORDER BY t.priority DESC, t.created_at DESC`,
        req.project!.id,
      );
      res.json({ data: tasks });
    }),
  );

  // Create a new task
  router.post(
    '/projects/:projectId/tasks',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const title = requireString(req.body, 'title').trim();
      const description = optionalString(req.body, 'description', 2000);
      const priority = Number(req.body?.priority ?? 1);
      if (priority < 1 || priority > 5) {
        throw new AppError('VALIDATION', 'Priority muss zwischen 1 und 5 liegen');
      }
      const status: TaskStatus = req.body?.status ?? 'open';
      if (!['open', 'in_progress', 'done', 'cancelled'].includes(status)) {
        throw new AppError('VALIDATION', 'Ungültiger Status');
      }

      const now = new Date().toISOString();
      const taskId = randomUUID();
      db.run(
        `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId,
        req.project!.id,
        title,
        description,
        status,
        priority,
        req.user!.id,
        now,
        now,
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'task.create',
        project_id: req.project!.id,
        target_type: 'task',
        target_id: taskId,
        result: 'success',
        detail: { title, status, priority },
        ip: clientIp(req),
      });

      const task = db.get<TaskDto>(
        `SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
          t.created_by, t.created_at, t.updated_at, t.closed_at,
          u.email AS created_by_email
         FROM tasks t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.id = ?`,
        taskId,
      );
      res.status(201).json({ data: task });
    }),
  );

  // Update a task (status or description)
  router.patch(
    '/projects/:projectId/tasks/:taskId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const taskId = param(req, 'taskId')!;
      const status = req.body?.status as TaskStatus | undefined;
      const description = optionalString(req.body, 'description', 2000);

      if (status && !['open', 'in_progress', 'done', 'cancelled'].includes(status)) {
        throw new AppError('VALIDATION', 'Ungültiger Status');
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (status) {
        updates.push('status = ?');
        params.push(status);
      }
      if (description !== undefined) {
        updates.push('description = COALESCE(?, description)');
        params.push(description);
      }
      if (updates.length === 0) {
        // Nothing to update, just return current
        const task = db.get<TaskDto>(
          `SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
            t.created_by, t.created_at, t.updated_at, t.closed_at,
            u.email AS created_by_email
           FROM tasks t
           LEFT JOIN users u ON u.id = t.created_by
           WHERE t.id = ?`,
          taskId,
        );
        return res.json({ data: task });
      }

      params.push(new Date().toISOString());
      params.push(taskId);

      db.run(
        `UPDATE tasks SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`,
        ...params,
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: status ? 'task.update.status' : 'task.update.description',
        project_id: req.project!.id,
        target_type: 'task',
        target_id: taskId,
        result: 'success',
        detail: { status, description },
        ip: clientIp(req),
      });

      const task = db.get<TaskDto>(
        `SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
          t.created_by, t.created_at, t.updated_at, t.closed_at,
          u.email AS created_by_email
         FROM tasks t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.id = ?`,
        taskId,
      );
      res.json({ data: task });
    }),
  );

  // Mark task as done
  router.post(
    '/projects/:projectId/tasks/:taskId/complete',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const taskId = param(req, 'taskId')!;
      const closedAt = new Date().toISOString();

      db.run(
        `UPDATE tasks SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?`,
        closedAt,
        new Date().toISOString(),
        taskId,
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'task.complete',
        project_id: req.project!.id,
        target_type: 'task',
        target_id: taskId,
        result: 'success',
        detail: { closed_at: closedAt },
        ip: clientIp(req),
      });

      const task = db.get<TaskDto>(
        `SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
          t.created_by, t.created_at, t.updated_at, t.closed_at,
          u.email AS created_by_email
         FROM tasks t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.id = ?`,
        taskId,
      );
      res.json({ data: task });
    }),
  );

  // Cancel task (soft-delete)
  router.delete(
    '/projects/:projectId/tasks/:taskId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const taskId = param(req, 'taskId')!;
      const now = new Date().toISOString();

      db.run(
        `UPDATE tasks SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        taskId,
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'task.cancel',
        project_id: req.project!.id,
        target_type: 'task',
        target_id: taskId,
        result: 'success',
        detail: { cancelled_at: now },
        ip: clientIp(req),
      });

      res.json({ data: { id: taskId, cancelled: true } });
    }),
  );

  return router;
}
