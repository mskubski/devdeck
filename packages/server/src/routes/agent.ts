import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  AGENT_PROTOCOL_VERSION,
  AppError,
  type EnrollRequest,
  type HeartbeatRequest,
} from '@devdeck/shared';
import { asyncHandler, optionalString, param, requireString } from '../http.js';
import type { AppContext } from '../context.js';
import { requireAgent } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { audit } from '../services/audit.js';
import { completeCommand, pollCommands } from '../services/provisioning.js';

/** Agent-Protokoll (pollbasiert, PLAN §11). */
export function agentRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();

  router.post(
    '/enroll',
    asyncHandler(async (req, res) => {
      const body = req.body as EnrollRequest;
      const enrollmentToken = requireString(body, 'enrollment_token');
      const name = requireString(body, 'name').slice(0, 120);
      const platform = optionalString(body, 'platform', 60) ?? process.platform;
      const agentVersion = optionalString(body, 'agent_version', 40) ?? '0.0.0';

      const row = db.get<{
        id: string;
        created_by: string;
        project_id: string | null;
        expires_at: string;
        used_at: string | null;
        revoked_at: string | null;
      }>(
        `SELECT id, created_by, project_id, expires_at, used_at, revoked_at
         FROM enrollment_tokens WHERE token_hash = ?`,
        hashToken(enrollmentToken),
      );

      const deny = (reason: string): never => {
        audit(db, {
          actor_type: 'agent',
          actor_label: name,
          action: 'machine.enroll',
          result: 'denied',
          detail: { reason },
        });
        throw new AppError('UNAUTHORIZED', `Enrollment abgelehnt: ${reason}`);
      };

      if (!row) deny('Token unbekannt');
      else if (row.revoked_at) deny('Token widerrufen');
      else if (row.used_at) deny('Token bereits verwendet');
      else if (new Date(row.expires_at).getTime() <= Date.now()) deny('Token abgelaufen');

      const machineToken = generateToken();
      const machineId = randomUUID();
      const now = new Date().toISOString();
      db.transaction(() => {
        db.run(
          `INSERT INTO machines (id, owner_user_id, name, platform, agent_version,
                                 agent_status, created_at, token_hash)
           VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`,
          machineId,
          row!.created_by,
          name,
          platform,
          agentVersion,
          now,
          hashToken(machineToken),
        );
        db.run('UPDATE enrollment_tokens SET used_at = ? WHERE id = ?', now, row!.id);
      });

      audit(db, {
        actor_type: 'agent',
        actor_id: machineId,
        actor_label: name,
        action: 'machine.enroll',
        machine_id: machineId,
        result: 'success',
        detail: { platform, agent_version: agentVersion, project_id: row!.project_id },
      });

      res.status(201).json({
        data: {
          machine_id: machineId,
          machine_token: machineToken,
          server_time: now,
          protocol_version: AGENT_PROTOCOL_VERSION,
        },
      });
    }),
  );

  router.use(requireAgent(db));

  router.post(
    '/heartbeat',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const body = (req.body ?? {}) as HeartbeatRequest;
      const now = new Date().toISOString();
      const agentVersion = optionalString(body, 'agent_version', 40);

      db.run(
        `UPDATE machines SET last_seen_at = ?, agent_status = 'online',
                             agent_version = COALESCE(?, agent_version)
         WHERE id = ?`,
        now,
        agentVersion ?? null,
        machine.id,
      );

      let registered = 0;
      const summaries = Array.isArray(body.workspaces) ? body.workspaces : [];
      for (const ws of summaries.slice(0, 50)) {
        if (!ws || typeof ws.local_path !== 'string') continue;
        let projectId: string | null = null;
        if (ws.project) {
          const project = db.get<{ id: string }>(
            'SELECT id FROM projects WHERE slug = ? OR lower(name) = lower(?)',
            ws.project,
            ws.project,
          );
          projectId = project?.id ?? null;
        }
        if (!projectId) continue;
        const existing = db.get<{ id: string }>(
          `SELECT id FROM workspaces WHERE project_id = ? AND machine_id = ? AND local_path = ?`,
          projectId,
          machine.id,
          ws.local_path,
        );
        if (existing) {
          db.run(
            `UPDATE workspaces SET branch = COALESCE(?, branch), status = COALESCE(?, status),
                                   updated_at = ? WHERE id = ?`,
            ws.branch ?? null,
            ws.status ?? null,
            now,
            existing.id,
          );
        } else {
          db.run(
            `INSERT INTO workspaces (id, project_id, machine_id, owner_user_id, local_path,
                                     repo_remote, branch, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
            randomUUID(),
            projectId,
            machine.id,
            machine.owner_user_id,
            ws.local_path,
            ws.branch ?? null,
            ws.status ?? 'unknown',
            now,
            now,
          );
        }
        registered += 1;
      }

      res.json({ data: { ok: true, server_time: now, workspaces: registered } });
    }),
  );

  // Long-Polling: wartet auf ausstehende Commands (204 wenn nichts kommt)
  router.get(
    '/commands',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const wait = Number(req.query.wait ?? 25) || 0;
      const commands = await pollCommands(db, machine.id, wait);
      if (commands.length === 0) {
        res.status(204).end();
        return;
      }
      res.json({ data: commands });
    }),
  );

  router.post(
    '/commands/:id/result',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const commandId = param(req, 'id')!;
      const status = req.body?.status;
      if (status !== 'done' && status !== 'failed') {
        throw new AppError('VALIDATION', 'status muss done oder failed sein');
      }
      const outcome = completeCommand(db, commandId, machine.id, {
        status,
        data: req.body?.data ?? undefined,
        error: req.body?.error ?? undefined,
      });
      res.json({ data: { ok: true, first_report: outcome.first } });
    }),
  );

  // Workspace-Status (Git + Readiness) vom Agenten melden
  router.post(
    '/workspaces/:id/status',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const workspaceId = param(req, 'id')!;
      const ws = db.get<{ id: string; machine_id: string | null; project_id: string }>(
        'SELECT id, machine_id, project_id FROM workspaces WHERE id = ?',
        workspaceId,
      );
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace nicht gefunden');
      if (ws.machine_id !== machine.id) {
        throw new AppError('FORBIDDEN', 'Workspace gehört zu einer anderen Maschine');
      }

      const body = req.body ?? {};
      const git = body.git ?? null;
      const readiness = body.readiness ?? null;
      const now = new Date().toISOString();

      let status = 'unknown';
      if (readiness && typeof readiness.overall === 'string') {
        status =
          readiness.overall === 'READY'
            ? 'ready'
            : readiness.overall === 'WARNING'
              ? 'warning'
              : 'blocked';
      }

      db.transaction(() => {
        db.run(
          `UPDATE workspaces SET
             branch = COALESCE(?, branch),
             last_git_commit = COALESCE(?, last_git_commit),
             status = ?, updated_at = ?
           WHERE id = ?`,
          git && typeof git.branch === 'string' ? git.branch : null,
          git && typeof git.commit === 'string' ? git.commit : null,
          status,
          now,
          workspaceId,
        );
        if (git && typeof git.commit === 'string' && git.commit) {
          db.run(
            `INSERT INTO git_metadata (id, project_id, workspace_id, commit_sha, branch, author,
                                       committed_at, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            randomUUID(),
            ws.project_id,
            workspaceId,
            git.commit,
            git.branch ?? null,
            git.author ?? null,
            git.committed_at ?? null,
            git.message ?? null,
            now,
          );
        }
      });

      audit(db, {
        actor_type: 'agent',
        actor_id: machine.id,
        actor_label: machine.name,
        action: 'workspace.status_report',
        project_id: ws.project_id,
        machine_id: machine.id,
        target_type: 'workspace',
        target_id: workspaceId,
        result: 'success',
        detail: { status, dirty: git?.dirty ?? null },
      });

      res.json({ data: { ok: true, status } });
    }),
  );

  // Session-Zustand vom Agenten (Start/Ende einer Coding Session)
  router.post(
    '/sessions/:id/state',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const sessionId = param(req, 'id')!;
      const session = db.get<{ id: string; project_id: string; status: string }>(
        'SELECT id, project_id, status FROM coding_sessions WHERE id = ?',
        sessionId,
      );
      if (!session) throw new AppError('NOT_FOUND', 'Session nicht gefunden');

      const state = req.body?.state;
      const now = new Date().toISOString();
      if (state === 'started') {
        db.run(
          `UPDATE coding_sessions SET status = 'open', machine_id = ? WHERE id = ?`,
          machine.id,
          sessionId,
        );
      } else if (state === 'finished') {
        db.run(
          `UPDATE coding_sessions SET status = 'closed', ended_at = COALESCE(ended_at, ?)
           WHERE id = ?`,
          now,
          sessionId,
        );
      } else {
        throw new AppError('VALIDATION', 'state muss started oder finished sein');
      }
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}
