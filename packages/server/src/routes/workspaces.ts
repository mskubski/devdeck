import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import { AppError, agentSupportsAction, type WorkspaceDto } from '@devdeck/shared';
import {
  asyncHandler,
  optionalString,
  param,
  requireConfirmation,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import { requireProjectRole, requireUser } from '../auth/middleware.js';
import { enqueueCommand, requestWorkspaceStatus, syncLogForProject } from '../services/provisioning.js';
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
  readiness_json?: string | null;
  git_json?: string | null;
  checked_at?: string | null;
}

function toWorkspaceDto(row: WorkspaceRow): WorkspaceDto {
  const { readiness_json, git_json, ...rest } = row;
  const parse = <T>(v: string | null | undefined): T | null => {
    try {
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  };
  return {
    ...rest,
    status: row.status as WorkspaceDto['status'],
    readiness: parse(readiness_json),
    git_state: parse(git_json),
    checked_at: row.checked_at ?? null,
  };
}

const WS_COLUMNS = `id, project_id, machine_id, owner_user_id, local_path, repo_remote, branch,
                    status, last_git_commit, last_sync_at, last_context_sync_at,
                    created_at, updated_at, readiness_json, git_json, checked_at`;

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

  /**
   * Der Agent darf nur unterhalb seines Workspace-Roots arbeiten (Sicherheitsregel). Das prüfen wir schon beim
   * Registrieren/Ändern, damit der Fehler nicht erst beim Sync auftaucht. Pfadlogik je nach Plattform der Maschine.
   */
  function assertInsideMachineRoot(machineId: string | null, localPath: string): void {
    if (!machineId) return;
    const m = db.get<{ name: string; platform: string; workspace_root: string | null }>(
      'SELECT name, platform, workspace_root FROM machines WHERE id = ?',
      machineId,
    );
    if (!m?.workspace_root) return; // Root (noch) unbekannt – der Agent prüft selbst
    const p = m.platform === 'win32' ? path.win32 : path.posix;
    const norm = (v: string): string => (m.platform === 'win32' ? v.toLowerCase() : v);
    const root = norm(p.resolve(m.workspace_root));
    const target = norm(p.resolve(localPath));
    const rel = p.relative(root, target);
    if (!p.isAbsolute(localPath) || rel.startsWith('..') || p.isAbsolute(rel)) {
      throw new AppError(
        'VALIDATION',
        `Der Pfad muss unterhalb des Workspace-Roots von „${m.name}“ liegen: ${m.workspace_root} ` +
          `(z. B. ${p.join(m.workspace_root, 'projektname')}). Den Root kannst du unter Maschinen ändern.`,
      );
    }
  }

  // Command an die Maschine eines Workspaces schicken
  function enqueueForWorkspace(
    workspace: WorkspaceRow,
    action: 'workspace.sync' | 'workspace.provision' | 'workspace.deploy' | 'project.import' | 'workspace.status',
    payload: Record<string, unknown>,
    requestedBy: string,
  ): string {
    if (!workspace.machine_id) {
      throw new AppError('AGENT_OFFLINE', 'Workspace ist keiner Maschine zugeordnet');
    }
    const machine = db.get<{ name: string; agent_version: string | null; agent_status: string; revoked_at: string | null }>(
      'SELECT name, agent_version, agent_status, revoked_at FROM machines WHERE id = ?',
      workspace.machine_id,
    );
    if (!machine || machine.revoked_at) {
      throw new AppError('AGENT_OFFLINE', 'Maschine widerrufen oder unbekannt');
    }
    if (machine.agent_status !== 'online') {
      throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
    }
    if (!agentSupportsAction(machine.agent_version, action)) {
      throw new AppError(
        'VALIDATION',
        `Der Agent auf „${machine.name}“ hat Version ${machine.agent_version ?? 'unbekannt'} und kennt diese Funktion noch nicht. ` +
          'Bitte zuerst aktualisieren: Maschinen → „Agent updaten“ oder System → „Server aktualisieren“ (mit „Agents mit aktualisieren“).',
      );
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

  // Sync-Log: Verlauf aller Sync-/Provision-Aufträge inkl. Fehlern
  router.get(
    '/projects/:projectId/sync-log',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({ data: syncLogForProject(db, req.project!.id) });
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

      assertInsideMachineRoot(machineId, localPath);
      const existing = db.get<{ id: string }>(
        `SELECT id FROM workspaces WHERE project_id = ? AND machine_id IS ? AND local_path = ?`,
        req.project!.id,
        machineId,
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
      requestWorkspaceStatus(db, loadWorkspace(id), req.user!.id); // Status gleich ermitteln, statt „unknown“ zu zeigen
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

      if (machineId && !db.get('SELECT id FROM machines WHERE id = ?', machineId)) {
        throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      }
      const effectiveMachine = machineId ?? ws.machine_id;
      const effectivePath = localPath ?? ws.local_path;
      if (localPath || machineId) assertInsideMachineRoot(effectiveMachine, effectivePath);
      if (localPath || machineId) {
        const clash = db.get<{ id: string }>(
          'SELECT id FROM workspaces WHERE project_id = ? AND machine_id IS ? AND local_path = ? AND id != ?',
          ws.project_id,
          effectiveMachine,
          effectivePath,
          ws.id,
        );
        if (clash) throw new AppError('CONFLICT', 'Für diesen Pfad auf dieser Maschine gibt es bereits einen Workspace');
      }

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
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'workspace.update',
        project_id: ws.project_id,
        machine_id: effectiveMachine,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
        detail: { from_path: ws.local_path, local_path: effectivePath, branch, repo_remote: repoRemote },
      });
      if (localPath || machineId) requestWorkspaceStatus(db, loadWorkspace(ws.id), user.id, true);
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

  // Deploy: Code auf den Ziel-Branch bringen und die im Manifest genannten Dienste neu starten (Maintainer)
  router.post(
    '/workspaces/:id/deploy',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      requireConfirmation(req.body);
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      const effective = role?.role ?? (user.system_role === 'admin' ? 'owner' : null);
      if (effective !== 'owner' && effective !== 'maintainer') {
        throw new AppError('FORBIDDEN', 'Deploy erfordert Maintainer-Rechte');
      }
      const running = db.get(
        `SELECT 1 FROM agent_commands WHERE machine_id IS ? AND status IN ('queued', 'running') AND action = 'workspace.deploy'
           AND json_extract(payload_json, '$.workspace_id') = ?`,
        ws.machine_id,
        ws.id,
      );
      if (running) throw new AppError('CONFLICT', 'F�r diesen Workspace l�uft bereits ein Deploy');
      const project = db.get<{ default_branch: string | null }>(
        'SELECT default_branch FROM projects WHERE id = ?',
        ws.project_id,
      );
      const commandId = enqueueForWorkspace(
        ws,
        'workspace.deploy',
        { branch: ws.branch ?? project?.default_branch ?? null },
        user.id,
      );
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'workspace.deploy.request',
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

  // Bestehende Projektdateien (CHANGELOG/ROADMAP/.env/credentials.md) über den Agenten importieren.
  // dry_run=true (Standard) liefert nur eine Vorschau; Secret-Werte werden nie zurückgegeben.
  router.post(
    '/workspaces/:id/import',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      const effective = role?.role ?? (user.system_role === 'admin' ? 'owner' : null);
      if (effective !== 'owner' && effective !== 'maintainer') {
        throw new AppError('FORBIDDEN', 'Import erfordert Maintainer-Rechte');
      }
      const environment = req.body?.environment ?? 'production';
      if (!['development', 'staging', 'production'].includes(environment)) {
        throw new AppError('VALIDATION', 'Ungültige Umgebung');
      }
      const dryRun = req.body?.dry_run !== false;
      const commandId = enqueueForWorkspace(
        ws,
        'project.import',
        { dry_run: dryRun, environment, overwrite: req.body?.overwrite === true },
        user.id,
      );
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'workspace.import.request',
        project_id: ws.project_id,
        machine_id: ws.machine_id,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
        detail: { command_id: commandId, dry_run: dryRun, environment },
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Status/Ergebnis eines Auftrags für die UI (Ergebnis enthält nie Secret-Werte)
  router.get(
    '/workspaces/:id/commands/:commandId',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      if (!role && user.system_role !== 'admin') throw new AppError('FORBIDDEN', 'Kein Zugriff auf diesen Workspace');
      const cmd = db.get<{ id: string; status: string; error: string | null; result_json: string | null }>(
        `SELECT id, status, error, result_json FROM agent_commands
         WHERE id = ? AND machine_id = ? AND json_extract(payload_json, '$.workspace_id') = ?`,
        param(req, 'commandId')!,
        ws.machine_id,
        ws.id,
      );
      if (!cmd) throw new AppError('NOT_FOUND', 'Auftrag nicht gefunden');
      res.json({
        data: { id: cmd.id, status: cmd.status, error: cmd.error, result: cmd.result_json ? JSON.parse(cmd.result_json) : null },
      });
    }),
  );

  // Nur prüfen (read-only): Git-Zustand + Readiness neu ermitteln, ohne zu synchronisieren
  router.post(
    '/workspaces/:id/check',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      if (!role && user.system_role !== 'admin') throw new AppError('FORBIDDEN', 'Kein Zugriff auf diesen Workspace');
      const commandId = enqueueForWorkspace(ws, 'workspace.status', {}, user.id);
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Workspace-Eintrag entfernen. Löscht NIE Dateien auf der Maschine – nur die Registrierung in DevDeck.
  router.delete(
    '/workspaces/:id',
    asyncHandler(async (req, res) => {
      const ws = loadWorkspace(param(req, 'id')!);
      const user = req.user!;
      requireConfirmation(req.body);
      const role = db.get<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
        ws.project_id,
        user.id,
      );
      const effective = role?.role ?? (user.system_role === 'admin' ? 'owner' : null);
      if (effective !== 'owner' && effective !== 'maintainer') {
        throw new AppError('FORBIDDEN', 'Entfernen erfordert Maintainer-Rechte');
      }
      const running = db.get(
        `SELECT 1 FROM agent_commands WHERE machine_id IS ? AND status = 'running'
           AND json_extract(payload_json, '$.workspace_id') = ?`,
        ws.machine_id,
        ws.id,
      );
      if (running) throw new AppError('CONFLICT', 'Für diesen Workspace läuft gerade ein Auftrag – bitte kurz warten');
      db.transaction(() => {
        // Noch wartende Aufträge für diesen Workspace verwerfen
        db.run(
          `UPDATE agent_commands SET status = 'expired', finished_at = ?, error = 'workspace removed'
           WHERE status = 'queued' AND json_extract(payload_json, '$.workspace_id') = ?`,
          new Date().toISOString(),
          ws.id,
        );
        db.run('DELETE FROM workspaces WHERE id = ?', ws.id);
      });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'workspace.delete',
        project_id: ws.project_id,
        machine_id: ws.machine_id,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
        detail: { local_path: ws.local_path },
      });
      res.json({ data: { ok: true } });
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
      const project = db.get<{ repo_remote: string | null; default_branch: string | null }>(
        'SELECT repo_remote, default_branch FROM projects WHERE id = ?',
        ws.project_id,
      );
      const commandId = enqueueForWorkspace(
        ws,
        'workspace.provision',
        {
          // Ohne eigene Angabe am Workspace gelten Repository und Standard-Branch des Projekts
          repo_remote: ws.repo_remote ?? project?.repo_remote ?? null,
          branch: ws.branch ?? project?.default_branch ?? null,
        },
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
