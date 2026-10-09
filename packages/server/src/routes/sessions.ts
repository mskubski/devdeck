import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { type CodingSessionDto, type HandoverDto, type SessionStatus } from '@devdeck/shared';
import {
  asyncHandler,
  clientIp,
  optionalString,
  param,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import { requireProjectRole, requireUser } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { AppError } from '@devdeck/shared';

export function sessionRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  function toCodingSessionDto(row: any): CodingSessionDto {
    return {
      id: row.id,
      project_id: row.project_id,
      workspace_id: row.workspace_id ?? null,
      machine_id: row.machine_id ?? null,
      user_id: row.user_id,
      agent_name: row.agent_name ?? null,
      status: row.status as SessionStatus,
      goal: row.goal ?? null,
      started_at: row.started_at,
      ended_at: row.ended_at ?? null,
      handover_id: row.handover_id ?? null,
      git_state: row.git_state_json ? JSON.parse(row.git_state_json) : null,
    };
  }

  function toHandoverDto(row: any): HandoverDto {
    return {
      id: row.id,
      session_id: row.session_id ?? null,
      project_id: row.project_id,
      payload: row.payload_json ? JSON.parse(row.payload_json) : {
        goal: '',
        completed: [],
        open_items: [],
        decisions: [],
        changed_files: [],
        notes: ''
      },
      validated_at: row.validated_at,
      created_at: row.created_at,
    };
  }

  function loadSession(id: string) {
    const session = db.get<any>(
      `SELECT cs.*, u.email AS user_email FROM coding_sessions cs
       JOIN users u ON u.id = cs.user_id
       WHERE cs.id = ?`,
      id
    );
    if (!session) throw new AppError('NOT_FOUND', 'Session nicht gefunden');
    return session;
  }

  function loadHandover(id: string) {
    const handover = db.get<any>(
      `SELECT h.*, u.email AS created_by_email FROM handovers h
       JOIN users u ON u.id = h.created_by
       WHERE h.id = ?`,
      id
    );
    if (!handover) throw new AppError('NOT_FOUND', 'Handover nicht gefunden');
    return handover;
  }

  // Start einer neuen Coding Session
  router.post(
    '/projects/:projectId/sessions',
    requireProjectRole(db, 'developer'),
        asyncHandler(async (req, res) => {
      const projectId = req.project!.id;
      const userId = req.user!.id;
      const goal = requireString(req.body, 'goal');
      const agentName = optionalString(req.body, 'agent_name', 100);
      const workspaceId = optionalString(req.body, 'workspace_id');
      const machineId = optionalString(req.body, 'machine_id');

      // Validate workspace belongs to project if provided
      if (workspaceId) {
        const workspace = db.get<{ id: string }>(
          'SELECT id FROM workspaces WHERE id = ? AND project_id = ?',
          workspaceId,
          projectId
        );
        if (!workspace) throw new AppError('NOT_FOUND', 'Workspace nicht gefunden im Projekt');
      }

      // Validate machine belongs to project if provided
      if (machineId) {
        const machine = db.get<{ id: string }>(
          'SELECT id FROM machines WHERE id = ? AND owner_user_id IN (SELECT user_id FROM project_members WHERE project_id = ?)',
          machineId,
          projectId
        );
        if (!machine) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden oder kein Zugriff');
      }

      const sessionId = randomUUID();
      const now = new Date().toISOString();
      
      db.run(
        `INSERT INTO coding_sessions (id, project_id, workspace_id, machine_id, user_id, 
                                    agent_name, started_at, status, goal)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        sessionId,
        projectId,
        workspaceId,
        machineId,
        userId,
        agentName,
        now,
        goal
      );

      audit(db, {
        actor_type: 'user',
        actor_id: userId,
        actor_label: req.user!.email,
        action: 'session.start',
        project_id: projectId,
        target_type: 'coding_session',
        target_id: sessionId,
        result: 'success',
        detail: { goal, agent_name: agentName, workspace_id: workspaceId, machine_id: machineId },
        ip: clientIp(req),
      });

      const session = db.get<any>(
        `SELECT cs.*, u.email AS user_email FROM coding_sessions cs
         JOIN users u ON u.id = cs.user_id
         WHERE cs.id = ?`,
        sessionId
      );
      
            res.status(201).json({ data: toCodingSessionDto(session) });
    })
  );

  // Liste alle Sessions für ein Projekt (mit Filtermöglichkeiten)
  router.get(
    '/projects/:projectId/sessions',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const projectId = req.project!.id;
      const status = optionalString(req.query, 'status');
      const limit = Number(req.query?.limit ?? 50);
      const offset = Number(req.query?.offset ?? 0);

      let query = `
        SELECT cs.*, u.email AS user_email 
        FROM coding_sessions cs
        JOIN users u ON u.id = cs.user_id
        WHERE cs.project_id = ?`;
      const params: any[] = [projectId];

      if (status) {
        query += ' AND cs.status = ?';
        params.push(status);
      }

      query += ' ORDER BY cs.started_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const sessions = db.all<any>(query, ...params);
      res.json({ data: sessions.map(toCodingSessionDto) });
    })
  );

  // Hole Details einer spezifischen Session
  router.get(
    '/projects/:projectId/sessions/:sessionId',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const sessionId = param(req, 'sessionId')!;
      const session = loadSession(sessionId);
      
      // Verify project access
      if (session.project_id !== req.project!.id) {
        throw new AppError('FORBIDDEN', 'Kein Zugriff auf diese Session');
      }

      res.json({ data: toCodingSessionDto(session) });
    })
  );

  // Beende eine Coding Session
  router.post(
    '/projects/:projectId/sessions/:sessionId/complete',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const sessionId = param(req, 'sessionId')!;
      const session = loadSession(sessionId);
      
      // Verify project access
      if (session.project_id !== req.project!.id) {
        throw new AppError('FORBIDDEN', 'Kein Zugriff auf diese Session');
      }

      // Verify user owns the session (or is maintainer/admin)
      if (session.user_id !== req.user!.id) {
        const membership = db.get<{ role: string }>(
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
          req.project!.id,
          req.user!.id
        );
        if (!membership || (membership.role !== 'maintainer' && membership.role !== 'admin')) {
          throw new AppError('FORBIDDEN', 'Nur der Session-Besitzer oder Maintainer/Admin kann die Session beenden');
        }
      }

      const now = new Date().toISOString();
      const endedAt = req.body?.ended_at ?? now;
      
      db.run(
        `UPDATE coding_sessions SET status = 'closed', ended_at = ? WHERE id = ?`,
        endedAt,
        sessionId
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'session.complete',
        project_id: req.project!.id,
        target_type: 'coding_session',
        target_id: sessionId,
        result: 'success',
        detail: { ended_at: endedAt },
        ip: clientIp(req),
      });

      const updatedSession = loadSession(sessionId);
      res.json({ data: toCodingSessionDto(updatedSession) });
    })
  );

  // Erstelle einen Handover von einer Session
  router.post(
    '/projects/:projectId/sessions/:sessionId/handover',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const sessionId = param(req, 'sessionId')!;
      const session = loadSession(sessionId);
      
      // Verify project access
      if (session.project_id !== req.project!.id) {
        throw new AppError('FORBIDDEN', 'Kein Zugriff auf diese Session');
      }

      // Verify user owns the session
      if (session.user_id !== req.user!.id) {
        throw new AppError('FORBIDDEN', 'Nur der Session-Besitzer kann einen Handover erstellen');
      }

      const projectId = req.project!.id;
      const payload = requireString(req.body, 'payload');
      const parsedPayload = JSON.parse(payload);
      
      const handoverId = randomUUID();
      const now = new Date().toISOString();
      
      // Create handover
      db.run(
        `INSERT INTO handovers (id, session_id, project_id, payload_json, validated_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        handoverId,
        sessionId,
        projectId,
        JSON.stringify(parsedPayload),
        now,
        now,
        req.user!.id
      );

      // Update session with handover reference
      db.run(
        `UPDATE coding_sessions SET handover_id = ? WHERE id = ?`,
        handoverId,
        sessionId
      );

      audit(db, {
        actor_type: 'user',
        actor_id: req.user!.id,
        actor_label: req.user!.email,
        action: 'handover.create',
        project_id: req.project!.id,
        target_type: 'handover',
        target_id: handoverId,
        result: 'success',
        detail: { session_id: sessionId },
        ip: clientIp(req),
      });

      const handover = db.get<any>(
        `SELECT h.*, u.email AS created_by_email FROM handovers h
         JOIN users u ON u.id = h.created_by
         WHERE h.id = ?`,
        handoverId
      );
      
      res.status(201).json({ data: toHandoverDto(handover) });
    })
  );

  // Liste alle Handovers für ein Projekt
  router.get(
    '/projects/:projectId/handovers',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const projectId = req.project!.id;
      const limit = Number(req.query?.limit ?? 50);
      const offset = Number(req.query?.offset ?? 0);

      const handovers = db.all<any>(
        `SELECT h.*, u.email AS created_by_email 
         FROM handovers h
         JOIN users u ON u.id = h.created_by
         WHERE h.project_id = ?
         ORDER BY h.created_at DESC
         LIMIT ? OFFSET ?`,
        projectId,
        limit,
        offset
      );
      
      res.json({ data: handovers.map(toHandoverDto) });
    })
  );

  return router;
}
