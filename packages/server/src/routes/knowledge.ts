import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError } from '@devdeck/shared';
import type { ChangelogEntryDto, DecisionDto, KnownIssueDto } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { asyncHandler, clientIp, optionalString, param, requireString } from '../http.js';
import { requireProjectRole, requireUser } from '../auth/middleware.js';
import { audit } from '../services/audit.js';

const DECISION_STATUS = ['proposed', 'accepted', 'superseded', 'rejected'];
const SEVERITY = ['low', 'medium', 'high'];
const ISSUE_STATUS = ['open', 'resolved'];

/** Phase E: Decisions, Changelog, Known Issues, History (Spezifikation §22). */
export function knowledgeRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  const log = (
    req: Parameters<typeof clientIp>[0],
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ) =>
    audit(db, {
      actor_type: 'user',
      actor_id: req.user!.id,
      actor_label: req.user!.email,
      action,
      project_id: req.project!.id,
      target_type: targetType,
      target_id: targetId,
      result: 'success',
      detail,
      ip: clientIp(req),
    });

  // ---------- Decisions ----------
  router.get(
    '/projects/:projectId/decisions',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({
        data: db.all<DecisionDto>(
          'SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC',
          req.project!.id,
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/decisions',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const title = requireString(req.body, 'title').trim();
      const status = (req.body?.status as string | undefined) ?? 'proposed';
      if (!DECISION_STATUS.includes(status)) throw new AppError('VALIDATION', 'Ungültiger Status');
      if (status !== 'proposed' && req.projectRole !== 'owner' && req.projectRole !== 'maintainer') {
        throw new AppError('FORBIDDEN', 'Nur Maintainer können direkt entscheiden');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO decisions (id, project_id, title, rationale, context, alternative, status, created_by, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        req.project!.id,
        title,
        optionalString(req.body, 'rationale', 5000),
        optionalString(req.body, 'context', 5000),
        optionalString(req.body, 'alternative', 5000),
        status,
        req.user!.id,
        now,
        status === 'proposed' ? null : now,
      );
      log(req, 'decision.create', 'decision', id, { title, status });
      res.status(201).json({ data: db.get<DecisionDto>('SELECT * FROM decisions WHERE id = ?', id) });
    }),
  );

  router.patch(
    '/projects/:projectId/decisions/:decisionId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'decisionId')!;
      const existing = db.get<DecisionDto>(
        'SELECT * FROM decisions WHERE id = ? AND project_id = ?',
        id,
        req.project!.id,
      );
      if (!existing) throw new AppError('NOT_FOUND', 'Decision nicht gefunden');
      const status = (req.body?.status as string | undefined) ?? existing.status;
      if (!DECISION_STATUS.includes(status)) throw new AppError('VALIDATION', 'Ungültiger Status');
      const decidedAt =
        status === 'proposed' ? null : existing.decided_at ?? new Date().toISOString();
      db.run(
        `UPDATE decisions SET title = ?, rationale = ?, context = ?, alternative = ?, status = ?, decided_at = ?
         WHERE id = ?`,
        req.body?.title ? requireString(req.body, 'title').trim() : existing.title,
        req.body && 'rationale' in req.body ? optionalString(req.body, 'rationale', 5000) : existing.rationale,
        req.body && 'context' in req.body ? optionalString(req.body, 'context', 5000) : existing.context,
        req.body && 'alternative' in req.body ? optionalString(req.body, 'alternative', 5000) : existing.alternative,
        status,
        decidedAt,
        id,
      );
      log(req, 'decision.update', 'decision', id, { status });
      res.json({ data: db.get<DecisionDto>('SELECT * FROM decisions WHERE id = ?', id) });
    }),
  );

  // ---------- Changelog ----------
  router.get(
    '/projects/:projectId/changelog',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({
        data: db.all<ChangelogEntryDto>(
          'SELECT * FROM changelog_entries WHERE project_id = ? ORDER BY created_at DESC LIMIT 200',
          req.project!.id,
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/changelog',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const summary = requireString(req.body, 'summary').trim();
      const id = randomUUID();
      db.run(
        `INSERT INTO changelog_entries (id, project_id, version, summary, body, source, session_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
        id,
        req.project!.id,
        optionalString(req.body, 'version', 50),
        summary,
        optionalString(req.body, 'body', 10_000),
        optionalString(req.body, 'session_id', 100),
        req.user!.id,
        new Date().toISOString(),
      );
      log(req, 'changelog.create', 'changelog_entry', id, { summary });
      res.status(201).json({ data: db.get<ChangelogEntryDto>('SELECT * FROM changelog_entries WHERE id = ?', id) });
    }),
  );

  // ---------- Known Issues ----------
  router.get(
    '/projects/:projectId/known-issues',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      res.json({
        data: db.all<KnownIssueDto>(
          `SELECT * FROM known_issues WHERE project_id = ?
           ORDER BY (status = 'open') DESC, CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, created_at DESC`,
          req.project!.id,
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/known-issues',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const title = requireString(req.body, 'title').trim();
      const severity = (req.body?.severity as string | undefined) ?? 'medium';
      if (!SEVERITY.includes(severity)) throw new AppError('VALIDATION', 'Ungültige Severity');
      const id = randomUUID();
      db.run(
        `INSERT INTO known_issues (id, project_id, title, description, status, severity, created_by, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
        id,
        req.project!.id,
        title,
        optionalString(req.body, 'description', 5000),
        severity,
        req.user!.id,
        new Date().toISOString(),
      );
      log(req, 'known_issue.create', 'known_issue', id, { title, severity });
      res.status(201).json({ data: db.get<KnownIssueDto>('SELECT * FROM known_issues WHERE id = ?', id) });
    }),
  );

  router.patch(
    '/projects/:projectId/known-issues/:issueId',
    requireProjectRole(db, 'developer'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'issueId')!;
      const existing = db.get<KnownIssueDto>(
        'SELECT * FROM known_issues WHERE id = ? AND project_id = ?',
        id,
        req.project!.id,
      );
      if (!existing) throw new AppError('NOT_FOUND', 'Known Issue nicht gefunden');
      const status = (req.body?.status as string | undefined) ?? existing.status;
      const severity = (req.body?.severity as string | undefined) ?? existing.severity;
      if (!ISSUE_STATUS.includes(status)) throw new AppError('VALIDATION', 'Ungültiger Status');
      if (!SEVERITY.includes(severity)) throw new AppError('VALIDATION', 'Ungültige Severity');
      db.run(
        `UPDATE known_issues SET title = ?, description = ?, status = ?, severity = ?, resolved_at = ? WHERE id = ?`,
        req.body?.title ? requireString(req.body, 'title').trim() : existing.title,
        req.body && 'description' in req.body ? optionalString(req.body, 'description', 5000) : existing.description,
        status,
        severity,
        status === 'resolved' ? existing.resolved_at ?? new Date().toISOString() : null,
        id,
      );
      log(req, 'known_issue.update', 'known_issue', id, { status, severity });
      res.json({ data: db.get<KnownIssueDto>('SELECT * FROM known_issues WHERE id = ?', id) });
    }),
  );

  // ---------- History (Zeitleiste über alle Wissensquellen) ----------
  router.get(
    '/projects/:projectId/history',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const pid = req.project!.id;
      const events = db.all<{ at: string; type: string; title: string; ref: string; actor: string | null }>(
        `SELECT * FROM (
           SELECT c.created_at AS at, 'changelog' AS type, c.summary AS title, c.id AS ref, u.email AS actor
             FROM changelog_entries c LEFT JOIN users u ON u.id = c.created_by WHERE c.project_id = ?
           UNION ALL
           SELECT d.created_at, 'decision', d.title || ' [' || d.status || ']', d.id, u.email
             FROM decisions d LEFT JOIN users u ON u.id = d.created_by WHERE d.project_id = ?
           UNION ALL
           SELECT k.created_at, 'known_issue', k.title || ' [' || k.severity || ']', k.id, u.email
             FROM known_issues k LEFT JOIN users u ON u.id = k.created_by WHERE k.project_id = ?
           UNION ALL
           SELECT k.resolved_at, 'known_issue_resolved', k.title, k.id, NULL
             FROM known_issues k WHERE k.project_id = ? AND k.resolved_at IS NOT NULL
           UNION ALL
           SELECT t.created_at, 'task', t.title, t.id, u.email
             FROM tasks t LEFT JOIN users u ON u.id = t.created_by WHERE t.project_id = ?
           UNION ALL
           SELECT t.closed_at, 'task_done', t.title, t.id, NULL
             FROM tasks t WHERE t.project_id = ? AND t.closed_at IS NOT NULL
           UNION ALL
           SELECT s.started_at, 'session', COALESCE(s.goal, '(kein Ziel)'), s.id, u.email
             FROM coding_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.project_id = ?
         ) ORDER BY at DESC LIMIT 200`,
        pid, pid, pid, pid, pid, pid, pid,
      );
      res.json({ data: events });
    }),
  );

  return router;
}
