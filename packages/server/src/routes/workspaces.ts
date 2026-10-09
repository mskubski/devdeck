import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError, type WorkspaceDto } from '@devdeck/shared';
import {
  asyncHandler,
  optionalString,
  param,
  requireConfirmation,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import { requireProjectRole, requireUser } from '../auth/middleware.js';
import { enqueueCommand } from '../services/provisioning.js';
import { audit } from '../services/audit.js';

interface WorkspaceRow {
  id: string;
  project_id: string;
  machine_id: string | null;
  owner_user_id: string;
  local_path: string;
  repo_remote: string | null;
  branch: string | null;
  status: string;
  last_git_commit: string | null;
  last_sync_at: string | null;
  last_context_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

function toWorkspaceDto(row: WorkspaceRow): WorkspaceDto {
  return { ...row, status: row.status as WorkspaceDto['status'] };
}

const WS_COLUMNS = `id, project_id, machine_id, owner_user_id, local_path, repo_remote, branch,
                    status, last_git_commit, last_sync_at, last_context_sync_at,
                    created_at, updated_at`;

/** Workspace Registry + Sync-/Provision-Aufträge an den Agenten. */
export function workspaceRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  function loadWorkspace(id: string): WorkspaceRow {
    const row = db.get<WorkspaceRow>(`SELECT ${WS_COLUMNS} FROM workspaces WHERE id = ?`, id);
    if (!row) throw new AppError('NOT_FOUND', 'Workspace nicht gefunden');
    return row;
  }

  // Command an die Maschine eines Workspaces schicken
  function enqueueForWorkspace(
    workspace: WorkspaceRow,
    action: 'workspace.sync' | 'workspace.provision',
    payload: Record<string, unknown>,
    requestedBy: string,
  ): string {
    if (!workspace.machine_id) {
      throw new AppError('AGENT_OFFLINE', 'Workspace ist keiner Maschine zugeordnet');
    }
    const machine = db.get<{ agent_status: string; revoked_at: string | null }>(
      'SELECT agent_status, revoked_at FROM machines WHERE id = ?',
      workspace.machine_id,
    );
    if (!machine || machine.revoked_at) {
      throw new AppError('AGENT_OFFLINE', 'Maschine widerrufen oder unbekannt');
    }
    if (machine.agent_status !== 'online') {
      throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
    }
    return enqueueCommand(db, {
      machineId: workspace.machine_id,
      action,
      payload: { workspace_id: workspace.id, local_path: workspace.local_path, ...payload },
      requestedBy,
    });
  }

  router.get(
    '/projects/:projectId/workspaces',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const rows = db.all<WorkspaceRow>(
        `SELECT ${WS_COLUMNS} FROM workspaces WHERE project_id = ? ORDER BY created_at`,
        req.project!.id,
      );
      res.json({ data: rows.map(toWorkspaceDto) });
    }),
  );

  router.post(
    '/projects/:projectId/workspaces',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const localPath = requireString(req.body, 'local_path');
      const repoRemote = optionalString(req.body, 'repo_remote', 500);
      const branch = optionalString(req.body, 'branch', 200);
      const machineId = optionalString(req.body, 'machine_id', 64);

      if (machineId) {
        const machine = db.get<{ id: string }>('SELECT id FROM machines WHERE id = ?', machineId);
        if (!machine) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      }

      const existing = db.get<{ id: string }>(
        `SELECT id FROM workspaces WHERE project_id = ? AND local_path = ?`,
        req.project!.id,
        localPath,
      );
      if (existing) throw new AppError('CONFLICT', 'Workspace für diesen Pfad bereits registriert');

      const now = new Date().toISOString();
      const id = randomUUID();
      db.run(
        `INSERT INTO workspaces (id, project_id, machine_id, owner_user_id, local_path,
                                 repo_remote, branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
        id,
        req.project!.id,
        machineId,
        req.user!.id,
        localPath,
        repoRemote,
        branch,
        now,
        now,
      );
      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'workspace.register',
        project_id: req.project!.id,
        machine_id: machineId,
        target_type: 'workspace',
        target_id: id,
        result: 'success',
        detail: { local_path: localPath },
      });
      res.status(201).json({ data: toWorkspaceDto(loadWorkspace(id)) });
    }),
  );

  router.get(
    '/workspaces/:id',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      // Rechte über Projekt-Membership prüfen
      const user = req.user!;
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      if (!role && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Kein Zugriff auf diesen Workspace');
      }
      res.json({ data: toWorkspaceDto(ws) });
    }),
  );

  router.patch(
    '/workspaces/:id',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      const rank: Record<string, number> = { viewer: 0, developer: 1, maintainer: 2, owner: 3 };
      const effective = role?.role ?? (user.system_role === 'admin' ? 'owner' : null);
      if (!effective || rank[effective]! < rank['developer']!) {
        throw new AppError('FORBIDDEN', 'Mindestens developer-Rechte nötig');
      }

      const localPath = optionalString(req.body, 'local_path', 1000);
      const repoRemote = optionalString(req.body, 'repo_remote', 500);
      const branch = optionalString(req.body, 'branch', 200);
      const machineId = optionalString(req.body, 'machine_id', 64);

      db.run(
        `UPDATE workspaces SET
           local_path = COALESCE(?, local_path),
           repo_remote = COALESCE(?, repo_remote),
           branch = COALESCE(?, branch),
           machine_id = COALESCE(?, machine_id),
           updated_at = ?
         WHERE id = ?`,
        localPath,
        repoRemote,
        branch,
        machineId,
        new Date().toISOString(),
        ws.id,
      );
      res.json({ data: toWorkspaceDto(loadWorkspace(ws.id)) });
    }),
  );

  // Sicheren Sync beauftragen (der Agent stoppt bei local changes automatisch)
  router.post(
    '/workspaces/:id/sync',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      if (!role && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Kein Zugriff auf diesen Workspace');
      }
      const commandId = enqueueForWorkspace(ws, 'workspace.sync', {}, user.id);
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'workspace.sync.request',
        project_id: ws.project_id,
        machine_id: ws.machine_id,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
        detail: { command_id: commandId },
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Provisionierung beauftragen – potenziell destruktiv → confirm
  router.post(
    '/workspaces/:id/provision',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      requireConfirmation(req.body);
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      const rank: Record<string, number> = { viewer: 0, developer: 1, maintainer: 2, owner: 3 };
      const effective = role?.role ?? (user.system_role === 'admin' ? 'owner' : null);
      if (!effective || rank[effective]! < rank['developer']!) {
        throw new AppError('FORBIDDEN', 'Mindestens developer-Rechte nötig');
      }
      const commandId = enqueueForWorkspace(
        ws,
        'workspace.provision',
        { repo_remote: ws.repo_remote, branch: ws.branch },
        user.id,
      );
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'workspace.provision.request',
        project_id: ws.project_id,
        machine_id: ws.machine_id,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
        detail: { command_id: commandId },
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  return router;
}
