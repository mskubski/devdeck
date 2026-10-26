import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
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
import { completeCommand, pollCommands, requestWorkspaceStatus } from '../services/provisioning.js';
import { buildProjectContext } from '../services/contextBuilder.js';
import { projectSecretsFor, secretVersionsFor } from '../vault/projection.js';
import { importProjectData, type ImportSecret } from '../services/projectImport.js';
import { sanitizeFacts } from '../services/architecture/facts.js';
import { sanitizeApplications, sanitizeAutostart, sanitizeInventory, sanitizePatches } from '../services/inventory.js';
import { pruneMachineLogs, sanitizeLogReport, storeMachineLogs } from '../services/machineLogs.js';
import { getProjectMembership } from '../auth/middleware.js';

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

      const previousVersion = machine.agent_version;
      db.run(
        `UPDATE machines SET last_seen_at = ?, agent_status = 'online',
                             agent_version = COALESCE(?, agent_version),
                             workspace_root = COALESCE(?, workspace_root),
                             agent_commit = COALESCE(?, agent_commit),
                             agent_node = COALESCE(?, agent_node),
                             agent_entry = COALESCE(?, agent_entry)
         WHERE id = ?`,
        now,
        agentVersion ?? null,
        optionalString(body, 'workspace_root', 1000) ?? null,
        optionalString(body, 'agent_commit', 60),
        optionalString(body, 'agent_node', 40),
        optionalString(body, 'agent_entry', 500),
        machine.id,
      );

      const inventory = sanitizeInventory(body.inventory);
      if (inventory) {
        db.run('UPDATE machines SET inventory_json = ?, inventory_at = ? WHERE id = ?', JSON.stringify(inventory), now, machine.id);
      }

      const applications = sanitizeApplications(body.applications);
      if (applications) {
        const collectedAt = typeof body.applications?.collected_at === 'string' ? body.applications.collected_at.slice(0, 40) : now;
        db.run('UPDATE machines SET applications_json = ?, applications_at = ? WHERE id = ?', JSON.stringify(applications), collectedAt, machine.id);
      }

      const patches = sanitizePatches(body.patches);
      if (patches) {
        db.run('UPDATE machines SET patches_json = ?, patches_at = ? WHERE id = ?', JSON.stringify(patches), patches.collected_at, machine.id);
      }

      const autostart = sanitizeAutostart(body.autostart);
      if (autostart) db.run('UPDATE machines SET autostart_json = ? WHERE id = ?', JSON.stringify(autostart), machine.id);

      const logReport = sanitizeLogReport(body.logs);
      if (logReport) {
        storeMachineLogs(db, machine.id, logReport.entries);
        pruneMachineLogs(db, { machineId: machine.id });
        db.run('UPDATE machines SET logs_at = ?, logs_notes_json = ? WHERE id = ?', logReport.collected_at, JSON.stringify(logReport.notes), machine.id);
      }

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

      // Nie geprüfte Workspaces dieser Maschine jetzt prüfen lassen (Status „unknown“ vermeiden)
      const unchecked = db.all<{ id: string; machine_id: string | null; local_path: string }>(
        `SELECT id, machine_id, local_path FROM workspaces WHERE machine_id = ? AND checked_at IS NULL`,
        machine.id,
      );
      for (const w of unchecked) requestWorkspaceStatus(db, w, null);
      // Neuer Agent-Code (z. B. nach einem Update) liefert andere/mehr Fakten → alle Workspaces der Maschine neu prüfen
      if (agentVersion && agentVersion !== previousVersion) {
        const all = db.all<{ id: string; machine_id: string | null; local_path: string }>(
          'SELECT id, machine_id, local_path FROM workspaces WHERE machine_id = ?', machine.id,
        );
        for (const w of all) requestWorkspaceStatus(db, w, null, true);
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
      if (status === 'done' && outcome.first) {
        const cmd = db.get<{ action: string }>('SELECT action FROM agent_commands WHERE id = ?', commandId);
        const state = cmd?.action === 'agent.autostart' ? sanitizeAutostart(req.body?.data) : null;
        if (state) db.run('UPDATE machines SET autostart_json = ? WHERE id = ?', JSON.stringify(state), machine.id);
        // Nach einer Installation steht der frische Patch-Stand im Ergebnis: sofort übernehmen
        const fresh = cmd?.action === 'patches.install' ? sanitizePatches(req.body?.data?.patches) : null;
        if (fresh) db.run('UPDATE machines SET patches_json = ?, patches_at = ? WHERE id = ?', JSON.stringify(fresh), fresh.collected_at, machine.id);
      }
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

      // Fakten für die Architektur-Karte: nur Namen/bereinigte Hosts; serverseitig nochmals begrenzt und bereinigt
      const factsJson = sanitizeFacts(body.facts);

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
             status = ?, updated_at = ?,
             readiness_json = ?, git_json = ?, checked_at = ?,
             facts_json = COALESCE(?, facts_json), facts_at = CASE WHEN ? IS NULL THEN facts_at ELSE ? END
           WHERE id = ?`,
          git && typeof git.branch === 'string' ? git.branch : null,
          git && typeof git.commit === 'string' ? git.commit : null,
          status,
          now,
          readiness ? JSON.stringify(readiness).slice(0, 20_000) : null,
          git ? JSON.stringify(git).slice(0, 20_000) : null,
          now,
          factsJson,
          factsJson,
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

  // Import vorhandener Projektdaten (CHANGELOG/ROADMAP/.env/credentials.md), vom Agenten aus dem Workspace gelesen
  router.post(
    '/import',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const ws = resolveOwnedWorkspace(req);
      // Der Maschinenbesitzer muss im Projekt mindestens Maintainer sein (wie beim manuellen Anlegen von Secrets)
      const owner = db.get<{ system_role: string }>('SELECT system_role FROM users WHERE id = ?', machine.owner_user_id);
      const role = getProjectMembership(db, ws.project_id, machine.owner_user_id);
      if (owner?.system_role !== 'admin' && role !== 'owner' && role !== 'maintainer') {
        throw new AppError('FORBIDDEN', 'Import erfordert Maintainer-Rechte im Projekt');
      }
      const arr = (v: unknown, max: number, what: string): any[] => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > max) throw new AppError('VALIDATION', `${what}: Array mit höchstens ${max} Einträgen erwartet`);
        return v;
      };
      const str = (v: unknown): v is string => typeof v === 'string';
      const changelog = arr(req.body?.changelog, 2000, 'changelog')
        .filter((c) => c && str(c.summary) && c.summary.trim())
        .map((c) => ({ version: str(c.version) ? c.version : null, date: str(c.date) ? c.date : null, summary: c.summary.trim(), body: str(c.body) ? c.body : null }));
      const tasks = arr(req.body?.tasks, 1000, 'tasks')
        .filter((t) => t && str(t.title) && t.title.trim())
        .map((t) => ({ title: t.title.trim(), done: t.done === true, priority: Number(t.priority) || 3, section: str(t.section) ? t.section : null }));
      const secrets: ImportSecret[] = arr(req.body?.secrets, 500, 'secrets')
        .filter((s) => s && str(s.name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name) && str(s.value) && s.value.length > 0 && s.value.length <= 50_000)
        .map((s) => ({
          name: s.name,
          value: s.value,
          environment: ['development', 'staging', 'production'].includes(s.environment) ? s.environment : 'production',
          source: str(s.source) ? s.source.slice(0, 200) : undefined,
        }));
      const summary = importProjectData(ctx, {
        projectId: ws.project_id,
        userId: machine.owner_user_id,
        actorLabel: `agent:${machine.name ?? machine.id}`,
        machineId: machine.id,
        changelog, tasks, secrets,
        overwrite: req.body?.overwrite === true,
        dryRun: req.body?.dry_run !== false,
      });
      res.json({ data: summary });
    }),
  );

  // Workspaces dieser Maschine (der Agent scannt nur diese Pfade nach Claude-Code-Sessions)
  router.get(
    '/workspaces',
    asyncHandler(async (req, res) => {
      const rows = db.all<{ id: string; project_id: string; local_path: string }>(
        'SELECT id, project_id, local_path FROM workspaces WHERE machine_id = ?',
        req.machine!.id,
      );
      res.json({ data: rows });
    }),
  );

  // Claude-Code-Sessions importieren (nur Metadaten, idempotent über external_id)
  router.post(
    '/sessions/import',
    asyncHandler(async (req, res) => {
      const machine = req.machine!;
      const list = Array.isArray(req.body?.sessions) ? (req.body.sessions as Array<Record<string, unknown>>) : null;
      if (!list) throw new AppError('VALIDATION', 'sessions muss ein Array sein');
      const str = (v: unknown, max: number): string | null =>
        typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
      const iso = (v: unknown): string | null => {
        const s = str(v, 40);
        return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
      };
      const ACTIVE_MS = 15 * 60_000;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const item of list.slice(0, 200)) {
        const externalId = str(item.external_id, 100);
        const startedAt = iso(item.started_at);
        const lastActivity = iso(item.last_activity_at) ?? startedAt;
        const wsId = str(item.workspace_id, 100);
        const ws = wsId
          ? db.get<{ id: string; project_id: string }>(
              'SELECT id, project_id FROM workspaces WHERE id = ? AND machine_id = ?',
              wsId,
              machine.id,
            )
          : undefined;
        if (!externalId || !startedAt || !lastActivity || !ws) {
          skipped++;
          continue;
        }
        const active = Date.now() - Date.parse(lastActivity) < ACTIVE_MS;
        const status = active ? 'open' : 'closed';
        const endedAt = active ? null : lastActivity;
        const count = Number.isFinite(Number(item.message_count)) ? Math.max(0, Math.floor(Number(item.message_count))) : null;
        const existing = db.get<{ id: string }>(
          'SELECT id FROM coding_sessions WHERE machine_id = ? AND external_id = ?',
          machine.id,
          externalId,
        );
        if (existing) {
          db.run(
            `UPDATE coding_sessions SET goal = COALESCE(?, goal), git_branch = COALESCE(?, git_branch),
               pr_url = COALESCE(?, pr_url), message_count = ?, last_activity_at = ?, status = ?, ended_at = ?
             WHERE id = ?`,
            str(item.title, 300),
            str(item.git_branch, 200),
            str(item.pr_url, 500),
            count,
            lastActivity,
            status,
            endedAt,
            existing.id,
          );
          updated++;
        } else {
          db.run(
            `INSERT INTO coding_sessions (id, project_id, workspace_id, machine_id, user_id, agent_name, started_at,
               ended_at, status, goal, source, external_id, git_branch, pr_url, message_count, last_activity_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude-code', ?, ?, ?, ?, ?)`,
            randomUUID(),
            ws.project_id,
            ws.id,
            machine.id,
            machine.owner_user_id,
            str(item.entrypoint, 60) ? `claude (${str(item.entrypoint, 60)})` : 'claude',
            startedAt,
            endedAt,
            status,
            str(item.title, 300),
            externalId,
            str(item.git_branch, 200),
            str(item.pr_url, 500),
            count,
            lastActivity,
          );
          created++;
        }
      }
      res.json({ data: { created, updated, skipped } });
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

  /** Workspace laden + sicherstellen, dass er der anfragenden Maschine gehört. */
  function resolveOwnedWorkspace(req: Request): { id: string; project_id: string } {
    const machine = req.machine!;
    const workspaceId = typeof req.body?.workspace_id === 'string' ? req.body.workspace_id : null;
    if (!workspaceId) {
      throw new AppError('VALIDATION', 'workspace_id ist erforderlich');
    }
    const ws = db.get<{ id: string; project_id: string; machine_id: string | null }>(
      'SELECT id, project_id, machine_id FROM workspaces WHERE id = ?',
      workspaceId,
    );
    if (!ws) throw new AppError('NOT_FOUND', 'Workspace nicht gefunden');
    if (ws.machine_id !== machine.id) {
      throw new AppError('FORBIDDEN', 'Workspace gehört zu einer anderen Maschine');
    }
    return { id: ws.id, project_id: ws.project_id };
  }

  // context.refresh / Workspace Sync+Provision: .devdeck/-Dateien aus SQLite erzeugen (Phase F).
  router.post(
    '/context/write',
    asyncHandler(async (req, res) => {
      const ws = resolveOwnedWorkspace(req);
      const files = buildProjectContext({ db, projectId: ws.project_id });
      const now = new Date().toISOString();
      db.run('UPDATE workspaces SET last_context_sync_at = ? WHERE id = ?', now, ws.id);
      audit(db, {
        actor_type: 'agent',
        actor_id: req.machine!.id,
        actor_label: req.machine!.name,
        action: 'context.write',
        project_id: ws.project_id,
        machine_id: req.machine!.id,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
      });
      res.json({ data: files });
    }),
  );

  // env.refresh / workspace.provision: autorisierte Secrets für den Maschinenbesitzer projizieren.
  router.post(
    '/secrets/fetch',
    asyncHandler(async (req, res) => {
      if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist auf diesem Server nicht initialisiert');
      const ws = resolveOwnedWorkspace(req);
      const machine = req.machine!;
      const owner = db.get<{ system_role: string }>(
        'SELECT system_role FROM users WHERE id = ?',
        machine.owner_user_id,
      );
      const environment =
        optionalString(req.body, 'environment') ?? 'development';
      const projected = projectSecretsFor(
        db,
        ctx.vault,
        ws.project_id,
        machine.owner_user_id,
        owner?.system_role === 'admin',
        environment,
      );
      audit(db, {
        actor_type: 'agent',
        actor_id: machine.id,
        actor_label: machine.name,
        action: 'secret.projection',
        project_id: ws.project_id,
        machine_id: machine.id,
        target_type: 'workspace',
        target_id: ws.id,
        result: 'success',
        detail: {
          environment,
          env_count: Object.keys(projected.env).length,
          file_count: projected.files.length,
        },
      });
      res.json({ data: projected });
    }),
  );

  // workspace.sync: leichte Versionsprüfung ohne Entschlüsselung (keine Secret-Werte).
  router.post(
    '/secrets/check',
    asyncHandler(async (req, res) => {
      const ws = resolveOwnedWorkspace(req);
      const environment = optionalString(req.body, 'environment') ?? 'development';
      const secrets = secretVersionsFor(db, ws.project_id, environment);
      res.json({ data: { environment, secrets } });
    }),
  );

  return router;
}
