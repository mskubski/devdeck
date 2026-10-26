import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError, MAX_PATCH_INSTALL_IDS, PATCH_ID_PATTERN, agentSupportsAction, compareVersions, isAgentOutdated, supportsSelfUpdate, type MachineApplication, type MachineApplicationsDto, type MachineAutostart, type MachineCustomField, type MachineDetailDto, type MachineDto, type MachineInventory, type MachineLogsDto, type MachinePatchInstallOutcome, type MachineSecurityAlert, type MachinePatches, type MachinePatchesDto, type ProjectRole } from '@devdeck/shared';
import {
  asyncHandler,
  clientIp,
  optionalString,
  param,
  requireConfirmation,
  requireString,
} from '../http.js';
import type { AppContext } from '../context.js';
import type { Database } from '../db/database.js';
import { getProjectMembership, requireUser, type MachineRecord } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { audit } from '../services/audit.js';
import { enqueueCommand } from '../services/provisioning.js';
import { sanitizeCustomFields } from '../services/inventory.js';
import { LOG_RETENTION_DAYS } from '../services/machineLogs.js';

/** Update lief „erfolgreich“, der Agent meldet aber noch eine ältere Version als die gebaute → Hinweis für die UI. */
function updateWarning(db: Database, row: MachineRecord): string | null {
  const last = db.get<{ finished_at: string | null; result_json: string | null }>(
    `SELECT finished_at, result_json FROM agent_commands
     WHERE machine_id = ? AND action = 'agent.update' AND status = 'done' ORDER BY finished_at DESC LIMIT 1`,
    row.id,
  );
  if (!last?.finished_at || !last.result_json || !row.agent_version) return null;
  // Dem Agenten etwas Zeit für den Neustart lassen
  if (Date.now() - Date.parse(last.finished_at) < 3 * 60_000) return null;
  try {
    const r = JSON.parse(last.result_json) as { new_version?: string; restarting?: boolean };
    if (r.restarting && r.new_version && compareVersions(row.agent_version, r.new_version) < 0) {
      return `Das letzte Update hat Version ${r.new_version} gebaut, der Agent läuft aber noch mit ${row.agent_version}. ` +
        'Vermutlich läuft er aus einem anderen Ordner, ein zweiter/älterer Agent-Prozess ist aktiv oder er wurde nicht neu gestartet – ' +
        'siehe Hilfe „Maschinen & Agent“.';
    }
  } catch {
    /* kein auswertbares Ergebnis */
  }
  return null;
}

function toMachineDto(row: MachineRecord, db: Database): MachineDto {
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    platform: row.platform,
    agent_version: row.agent_version,
    workspace_root: row.workspace_root,
    agent_outdated: isAgentOutdated(row.agent_version),
    agent_can_self_update: supportsSelfUpdate(row.agent_version),
    agent_commit: row.agent_commit ?? null,
    agent_node: row.agent_node ?? null,
    agent_entry: row.agent_entry ?? null,
    update_warning: updateWarning(db, row),
    agent_status: row.revoked_at ? 'revoked' : (row.agent_status as MachineDto['agent_status']),
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    autostart: parseAutostart(row.autostart_json),
    agent_can_autostart: agentSupportsAction(row.agent_version, 'agent.autostart'),
    agent_can_install_patches: agentSupportsAction(row.agent_version, 'patches.install'),
  };
}

function parseAutostart(json: string | null | undefined): MachineAutostart | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as MachineAutostart;
  } catch {
    return null;
  }
}

const MACHINE_COLUMNS = `id, owner_user_id, name, platform, agent_version, workspace_root, agent_commit, agent_node, agent_entry, agent_status,
                         last_seen_at, token_hash, revoked_at, created_at, autostart_json`;

/** Machine Registry: Enrollment-Tokens, Übersicht, Widerruf (Spezifikation §15). */
export function machineRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  // Enrollment-Token erzeugen (einmalig, ablaufend, gehasht gespeichert)
  router.post(
    '/enrollment-tokens',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const projectId = optionalString(req.body, 'project_id', 64);
      const ttlMinutes = Math.min(Number(req.body?.ttl_minutes ?? 60) || 60, 24 * 60);

      if (projectId) {
        const role = getProjectMembership(db, projectId, user.id);
        const effective: ProjectRole | null =
          role ?? (user.system_role === 'admin' ? 'owner' : null);
        if (!effective || (effective !== 'owner' && effective !== 'maintainer')) {
          throw new AppError('FORBIDDEN', 'Nur Owner/Maintainer dürfen Enrollment-Tokens erzeugen');
        }
        if (!db.get('SELECT id FROM projects WHERE id = ?', projectId)) {
          throw new AppError('NOT_FOUND', 'Projekt nicht gefunden');
        }
      } else if (user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Ohne project_id ist nur admin berechtigt');
      }

      const token = generateToken();
      const now = new Date();
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
      db.run(
        `INSERT INTO enrollment_tokens (id, token_hash, created_by, project_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        hashToken(token),
        user.id,
        projectId,
        expiresAt,
        now.toISOString(),
      );
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.enrollment_token.create',
        project_id: projectId,
        target_type: 'enrollment_token',
        target_id: id,
        result: 'success',
        detail: { ttl_minutes: ttlMinutes },
        ip: clientIp(req),
      });
      // Einmaliges Plaintext-Token – wird nie gespeichert
      res.status(201).json({ data: { id, token, expires_at: expiresAt } });
    }),
  );

  // Machine-Übersicht: global (admin) oder projektbezogen (Mitglied)
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;

      if (projectId) {
        const role = getProjectMembership(db, projectId, user.id);
        const isAdmin = user.system_role === 'admin';
        if (!role && !isAdmin) throw new AppError('FORBIDDEN', 'Kein Zugriff auf dieses Projekt');
        const rows = db.all<MachineRecord>(
          `SELECT ${MACHINE_COLUMNS} FROM machines
           WHERE owner_user_id IN (SELECT user_id FROM project_members WHERE project_id = ?)
           ORDER BY name`,
          projectId,
        );
        res.json({ data: rows.map((r) => toMachineDto(r, db)) });
        return;
      }
      if (user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Globale Machine-Liste nur für admin');
      }
      const rows = db.all<MachineRecord>(
        `SELECT ${MACHINE_COLUMNS} FROM machines ORDER BY name`,
      );
      res.json({ data: rows.map((r) => toMachineDto(r, db)) });
    }),
  );

  /** Maschine laden; Zugriff für Besitzer, Admins und Mitglieder eines Projekts, das einen Workspace darauf hat. */
  function loadAccessible(userId: string, systemRole: string, id: string): MachineRecord {
    const row = db.get<MachineRecord>(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`, id);
    if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
    if (row.owner_user_id !== userId && systemRole !== 'admin') {
      const member = db.get(
        `SELECT 1 AS x FROM project_members WHERE user_id = ? AND project_id IN
         (SELECT project_id FROM workspaces WHERE machine_id = ?)`,
        userId,
        id,
      );
      if (!member) throw new AppError('FORBIDDEN', 'Kein Zugriff auf diese Maschine');
    }
    return row;
  }

  // Installierte Software (eigener Aufruf, weil die Liste lang sein kann)
  router.get(
    '/:id/applications',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id')!;
      loadAccessible(req.user!.id, req.user!.system_role, id);
      const r = db.get<{ applications_json: string | null; applications_at: string | null }>(
        'SELECT applications_json, applications_at FROM machines WHERE id = ?',
        id,
      );
      let applications: MachineApplication[] = [];
      try {
        applications = r?.applications_json ? (JSON.parse(r.applications_json) as MachineApplication[]) : [];
      } catch {
        applications = [];
      }
      const data: MachineApplicationsDto = { applications, applications_at: r?.applications_at ?? null };
      res.json({ data });
    }),
  );

  // Fehlerprotokolle: neueste zuerst, filterbar nach Protokoll, Ebene und Text
  router.get(
    '/:id/logs',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id')!;
      loadAccessible(req.user!.id, req.user!.system_role, id);
      const source = typeof req.query.source === 'string' && req.query.source ? req.query.source : null;
      const level = req.query.level === 'critical' || req.query.level === 'error' ? req.query.level : null;
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const entries = db.all<MachineLogsDto['entries'][number]>(
        `SELECT id, occurred_at AS time, source, provider, event_id, level, message FROM machine_logs
         WHERE machine_id = ? AND (? IS NULL OR source = ?) AND (? IS NULL OR level = ?)
           AND (? = '' OR message LIKE ? ESCAPE '\\' OR COALESCE(provider, '') LIKE ? ESCAPE '\\' OR COALESCE(event_id, '') LIKE ? ESCAPE '\\')
         ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        id, source, source, level, level, q, like, like, like, limit,
      );
      const sources = db.all<{ source: string; count: number }>(
        'SELECT source, COUNT(*) AS count FROM machine_logs WHERE machine_id = ? GROUP BY source ORDER BY count DESC, source',
        id,
      );
      const meta = db.get<{ logs_at: string | null; logs_notes_json: string | null }>('SELECT logs_at, logs_notes_json FROM machines WHERE id = ?', id);
      let notes: string[] = [];
      try {
        notes = meta?.logs_notes_json ? (JSON.parse(meta.logs_notes_json) as string[]) : [];
      } catch {
        notes = [];
      }
      const data: MachineLogsDto = {
        entries, sources, total: sources.reduce((n, s) => n + s.count, 0), logs_at: meta?.logs_at ?? null, notes, retention_days: LOG_RETENTION_DAYS,
      };
      res.json({ data });
    }),
  );

  // Maschinen mit ausstehenden sicherheitsrelevanten Updates (für die Anzeige in der Kopfleiste); nur Maschinen, auf die der Benutzer Zugriff hat
  router.get(
    '/security-summary',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const scope = user.system_role === 'admin'
        ? ''
        : `AND (owner_user_id = ? OR id IN (SELECT machine_id FROM workspaces WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)))`;
      const rows = db.all<{ id: string; name: string; security: number; critical: number | null; reboot: number | null }>(
        `SELECT id, name, json_extract(patches_json, '$.security') AS security, json_extract(patches_json, '$.critical') AS critical,
                json_extract(patches_json, '$.reboot_required') AS reboot
         FROM machines
         WHERE revoked_at IS NULL AND patches_json IS NOT NULL AND json_extract(patches_json, '$.security') > 0 ${scope}
         ORDER BY critical DESC, security DESC, name`,
        ...(user.system_role === 'admin' ? [] : [user.id, user.id]),
      );
      const data: MachineSecurityAlert[] = rows.map((r) => ({
        id: r.id, name: r.name, security: r.security, critical: r.critical ?? 0, reboot_required: r.reboot === null ? null : Boolean(r.reboot),
      }));
      res.json({ data });
    }),
  );

  // Patch-Stand (eigener Aufruf wie die Software-Liste)
  router.get(
    '/:id/patches',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id')!;
      loadAccessible(req.user!.id, req.user!.system_role, id);
      const r = db.get<{ patches_json: string | null; patches_at: string | null }>('SELECT patches_json, patches_at FROM machines WHERE id = ?', id);
      let patches: MachinePatches | null = null;
      try {
        patches = r?.patches_json ? (JSON.parse(r.patches_json) as MachinePatches) : null;
      } catch {
        patches = null;
      }
      const data: MachinePatchesDto = { patches, patches_at: r?.patches_at ?? null };
      res.json({ data });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id')!;
      const row = loadAccessible(req.user!.id, req.user!.system_role, id);
      const extra = db.get<{ inventory_json: string | null; inventory_at: string | null; custom_fields_json: string | null }>(
        'SELECT inventory_json, inventory_at, custom_fields_json FROM machines WHERE id = ?',
        id,
      );
      const parse = <T>(v: string | null | undefined): T | null => {
        try {
          return v ? (JSON.parse(v) as T) : null;
        } catch {
          return null;
        }
      };
      const detail: MachineDetailDto = {
        ...toMachineDto(row, db),
        inventory: parse<MachineInventory>(extra?.inventory_json),
        inventory_at: extra?.inventory_at ?? null,
        custom_fields: parse<MachineCustomField[]>(extra?.custom_fields_json) ?? [],
      };
      res.json({ data: detail });
    }),
  );

  // Freie Felder (Label/Wert) einer Maschine ersetzen – Besitzer oder admin
  router.put(
    '/:id/custom-fields',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const row = db.get<MachineRecord>(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`, id);
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf die Felder ändern');
      }
      const fields = sanitizeCustomFields(req.body?.fields);
      if (!fields) throw new AppError('VALIDATION', 'fields muss eine Liste mit höchstens 30 Einträgen sein');
      db.run('UPDATE machines SET custom_fields_json = ? WHERE id = ?', JSON.stringify(fields), id);
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.custom_fields.update',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        detail: { count: fields.length },
        ip: clientIp(req),
      });
      res.json({ data: { custom_fields: fields } });
    }),
  );

  // Workspace-Root des Agenten remote ändern (Befehl agent.configure)
  router.post(
    '/:id/workspace-root',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const root = requireString(req.body, 'workspace_root').trim().slice(0, 1000);
      const row = db.get<MachineRecord>(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`, id);
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf den Workspace-Root ändern');
      }
      if (row.revoked_at) throw new AppError('AGENT_OFFLINE', 'Maschine ist widerrufen');
      if (row.agent_status !== 'online') throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
      if (!supportsSelfUpdate(row.agent_version)) {
        throw new AppError(
          'VALIDATION',
          `Agent auf „${row.name}“ ist veraltet (${row.agent_version ?? 'unbekannt'}) und kennt diesen Befehl nicht. ` +
            'Einmalig manuell aktualisieren: "git pull && npm run build" und Agent neu starten ' +
            '(ggf. mit --workspace-root <Pfad>). Danach sind Updates über die Web UI möglich.',
        );
      }
      const commandId = enqueueCommand(db, {
        machineId: id,
        action: 'agent.configure',
        payload: { workspace_root: root },
        requestedBy: user.id,
      });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.workspace_root.request',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        detail: { command_id: commandId, workspace_root: root },
        ip: clientIp(req),
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Agent aktualisieren (git pull --ff-only, Build, Neustart)
  router.post(
    '/:id/update',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const row = db.get<MachineRecord>(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`, id);
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf den Agent aktualisieren');
      }
      if (row.revoked_at) throw new AppError('AGENT_OFFLINE', 'Maschine ist widerrufen');
      if (row.agent_status !== 'online') throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
      if (!supportsSelfUpdate(row.agent_version)) {
        throw new AppError(
          'VALIDATION',
          'Dieser Agent kennt noch kein Selbst-Update – bitte einmalig manuell aktualisieren (git pull && npm run build, Agent neu starten).',
        );
      }
      const commandId = enqueueCommand(db, {
        machineId: id,
        action: 'agent.update',
        payload: {},
        requestedBy: user.id,
        ttlSeconds: 300,
      });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.agent_update.request',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        detail: { command_id: commandId },
        ip: clientIp(req),
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Autostart des Agents auf der Maschine ein-/ausschalten (Windows: Run-Schlüssel, Linux: systemd-Benutzerdienst, macOS: LaunchAgent)
  router.post(
    '/:id/autostart',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const row = db.get<MachineRecord>(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`, id);
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf den Autostart ändern');
      }
      if (typeof req.body?.enabled !== 'boolean') throw new AppError('VALIDATION', 'enabled (true/false) fehlt');
      const enabled = req.body.enabled as boolean;
      if (row.revoked_at) throw new AppError('AGENT_OFFLINE', 'Maschine ist widerrufen');
      if (row.agent_status !== 'online') throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
      if (!agentSupportsAction(row.agent_version, 'agent.autostart')) {
        throw new AppError('VALIDATION', 'Dieser Agent kennt den Autostart noch nicht – bitte zuerst den Agent aktualisieren.');
      }
      const commandId = enqueueCommand(db, {
        machineId: id,
        action: 'agent.autostart',
        payload: { enabled },
        requestedBy: user.id,
        ttlSeconds: 300,
      });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: enabled ? 'machine.autostart.enable' : 'machine.autostart.disable',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        detail: { command_id: commandId },
        ip: clientIp(req),
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Ausgewählte Updates installieren (Betriebssystem und Programme). Ein Neustart wird nie ausgelöst, nur gemeldet.
  router.post(
    '/:id/patches/install',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const row = db.get<MachineRecord>(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`, id);
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf Updates installieren');
      }
      const ids: unknown = req.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PATCH_INSTALL_IDS
        || !ids.every((i) => typeof i === 'string' && PATCH_ID_PATTERN.test(i))) {
        throw new AppError('VALIDATION', `ids: 1 bis ${MAX_PATCH_INSTALL_IDS} gültige Update-Kennungen erwartet`);
      }
      if (row.revoked_at) throw new AppError('AGENT_OFFLINE', 'Maschine ist widerrufen');
      if (row.agent_status !== 'online') throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
      if (!agentSupportsAction(row.agent_version, 'patches.install')) {
        throw new AppError('VALIDATION', 'Dieser Agent kann noch keine Updates installieren – bitte zuerst den Agent aktualisieren.');
      }
      const busy = db.get(`SELECT 1 AS x FROM agent_commands WHERE machine_id = ? AND action = 'patches.install' AND status IN ('queued', 'running')`, id);
      if (busy) throw new AppError('CONFLICT', 'Auf dieser Maschine läuft bereits eine Update-Installation');
      const unique = [...new Set(ids as string[])];
      const commandId = enqueueCommand(db, { machineId: id, action: 'patches.install', payload: { ids: unique }, requestedBy: user.id, ttlSeconds: 600 });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.patches.install',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        detail: { command_id: commandId, count: unique.length, ids: unique.slice(0, 20) },
        ip: clientIp(req),
      });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // Status eines Befehls (für UI-Rückmeldung)
  router.get(
    '/:id/commands/:commandId',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      const row = db.get<{ owner_user_id: string }>('SELECT owner_user_id FROM machines WHERE id = ?', id);
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Kein Zugriff auf diese Maschine');
      }
      const cmd = db.get<{ id: string; action: string; status: string; error: string | null; result_json: string | null }>(
        'SELECT id, action, status, error, result_json FROM agent_commands WHERE id = ? AND machine_id = ?',
        param(req, 'commandId')!,
        id,
      );
      if (!cmd) throw new AppError('NOT_FOUND', 'Befehl nicht gefunden');
      let outcome: MachinePatchInstallOutcome | null = null;
      if (cmd.action === 'patches.install' && cmd.status === 'done' && cmd.result_json) {
        try {
          const raw = JSON.parse(cmd.result_json) as { results?: unknown; reboot_required?: unknown };
          outcome = {
            results: (Array.isArray(raw.results) ? raw.results : []).slice(0, MAX_PATCH_INSTALL_IDS).map((r: any) => ({
              id: String(r?.id ?? '').slice(0, 120), name: typeof r?.name === 'string' ? r.name.slice(0, 200) : null,
              ok: r?.ok === true, message: String(r?.message ?? '').slice(0, 300),
            })),
            reboot_required: typeof raw.reboot_required === 'boolean' ? raw.reboot_required : null,
          };
        } catch {
          outcome = null;
        }
      }
      res.json({ data: { id: cmd.id, status: cmd.status, error: cmd.error, ...(outcome ? { outcome } : {}) } });
    }),
  );

  // Widerruf: Agent-Credentials müssen widerrufbar sein (Spec §28)
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const id = param(req, 'id')!;
      requireConfirmation(req.body);
      const row = db.get<MachineRecord>(
        `SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`,
        id,
      );
      if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
      if (row.owner_user_id !== user.id && user.system_role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf widerrufen');
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        db.run('UPDATE machines SET revoked_at = ?, agent_status = ? WHERE id = ?', now, 'offline', id);
        db.run(
          `UPDATE agent_commands SET status = 'expired', finished_at = ?, error = 'machine revoked'
           WHERE machine_id = ? AND status IN ('queued', 'running')`,
          now,
          id,
        );
        db.run(
          `UPDATE workspaces SET status = 'offline', updated_at = ? WHERE machine_id = ?`,
          now,
          id,
        );
      });
      audit(db, {
        actor_type: 'user',
        actor_id: user.id,
        actor_label: user.email,
        action: 'machine.revoke',
        machine_id: id,
        target_type: 'machine',
        target_id: id,
        result: 'success',
        ip: clientIp(req),
      });
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}
