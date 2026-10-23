import { randomUUID } from 'node:crypto';
import { type AgentAction, type AgentCommandPayload, AppError } from '@devdeck/shared';
import type { Database } from '../db/database.js';

/**
 * Command-Queue für das pollbasierte Agent-Protokoll (PLAN §11).
 * Der Server treibt nichts an – der Agent holt Aufträge per Long-Poll ab.
 */
export const MAX_POLL_WAIT_SECONDS = 30;
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface EnqueueCommandOptions {
  machineId: string;
  action: AgentAction;
  payload?: Record<string, unknown>;
  requestedBy?: string | null;
  ttlSeconds?: number;
}

export interface CommandRow {
  id: string;
  machine_id: string;
  action: string;
  payload_json: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export function enqueueCommand(db: Database, opts: EnqueueCommandOptions): string {
  const id = randomUUID();
  const now = new Date();
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  db.run(
    `INSERT INTO agent_commands
       (id, machine_id, action, payload_json, status, created_at, expires_at, requested_by)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    id,
    opts.machineId,
    opts.action,
    JSON.stringify(opts.payload ?? {}),
    now.toISOString(),
    new Date(now.getTime() + ttl * 1000).toISOString(),
    opts.requestedBy ?? null,
  );
  return id;
}

/**
 * Prüfung (workspace.status) eines Workspaces anstoßen, sofern die Maschine online ist und nicht bereits
 * eine läuft/wartet oder in den letzten 10 Minuten angefordert wurde. Liefert die Command-ID oder null.
 */
export function requestWorkspaceStatus(
  db: Database,
  ws: { id: string; machine_id: string | null; local_path: string },
  requestedBy: string | null,
  force = false,
): string | null {
  if (!ws.machine_id) return null;
  const machine = db.get<{ agent_status: string; revoked_at: string | null }>(
    'SELECT agent_status, revoked_at FROM machines WHERE id = ?',
    ws.machine_id,
  );
  if (!machine || machine.revoked_at || machine.agent_status !== 'online') return null;
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const pending = db.get(
    `SELECT 1 FROM agent_commands
     WHERE machine_id = ? AND action = 'workspace.status' AND json_extract(payload_json, '$.workspace_id') = ?
       AND (status IN ('queued','running') OR (? = 0 AND created_at > ?))`,
    ws.machine_id,
    ws.id,
    force ? 1 : 0,
    since,
  );
  if (pending) return null;
  return enqueueCommand(db, {
    machineId: ws.machine_id,
    action: 'workspace.status',
    payload: { workspace_id: ws.id, local_path: ws.local_path },
    requestedBy,
    ttlSeconds: 600,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ablaufende Commands markieren. */
export function sweepExpiredCommands(db: Database): number {
  const now = new Date().toISOString();
  // Hängende „running“-Aufträge (Agent beendet/neu gestartet, bevor er ein Ergebnis melden konnte) nach 30 Minuten abschließen
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  db.run(
    `UPDATE agent_commands SET status = 'failed', finished_at = ?,
       error = 'Kein Ergebnis vom Agenten (Prozess vermutlich beendet oder neu gestartet)'
     WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`,
    now,
    stale,
  );
  const res = db.run(
    `UPDATE agent_commands SET status = 'expired', finished_at = ?, error = 'expired'
     WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at < ?`,
    now,
    now,
  );
  return res.changes;
}

/** Maschinen ohne Heartbeat als offline markieren. */
export function sweepOfflineAgents(db: Database, offlineAfterMs = 90_000): number {
  const cutoff = new Date(Date.now() - offlineAfterMs).toISOString();
  const res = db.run(
    `UPDATE machines SET agent_status = 'offline'
     WHERE agent_status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    cutoff,
  );
  return res.changes;
}

/**
 * Long-Poll: wartet bis zu `waitSeconds` auf neue Commands der Maschine.
 * Anspruch (Claim) erfolgt atomar über Statuswechsel queued → running.
 */
export async function pollCommands(
  db: Database,
  machineId: string,
  waitSeconds: number,
): Promise<AgentCommandPayload[]> {
  const wait = Math.max(0, Math.min(waitSeconds, MAX_POLL_WAIT_SECONDS));
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    sweepExpiredCommands(db);
    const now = new Date().toISOString();
    const queued = db.all<CommandRow>(
      `SELECT id, machine_id, action, payload_json, status, created_at, expires_at
       FROM agent_commands
       WHERE machine_id = ? AND status = 'queued'
       ORDER BY created_at
       LIMIT 5`,
      machineId,
    );
    const claimed: AgentCommandPayload[] = [];
    for (const cmd of queued) {
      const res = db.run(
        `UPDATE agent_commands SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'queued'`,
        now,
        cmd.id,
      );
      if (res.changes === 1) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(cmd.payload_json) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        claimed.push({
          id: cmd.id,
          action: cmd.action as AgentAction,
          payload,
          created_at: cmd.created_at,
          expires_at: cmd.expires_at,
        });
      }
    }
    if (claimed.length > 0) return claimed;
    if (Date.now() >= deadline) return [];
    await sleep(250);
  }
}

export interface CommandResultInput {
  status: 'done' | 'failed';
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** Resultat einmalig pro Command speichern (idempotent). */
export function completeCommand(
  db: Database,
  commandId: string,
  machineId: string,
  result: CommandResultInput,
): { first: boolean } {
  const row = db.get<{ status: string; machine_id: string; action: string; payload_json: string }>(
    'SELECT status, machine_id, action, payload_json FROM agent_commands WHERE id = ?',
    commandId,
  );
  if (!row || row.machine_id !== machineId) {
    throw new AppError('NOT_FOUND', 'Command nicht gefunden');
  }
  if (row.status === 'done' || row.status === 'failed') {
    return { first: false }; // idempotent erneut gemeldet
  }
  const res = db.run(
    `UPDATE agent_commands SET status = ?, finished_at = ?, result_json = ?, error = ?
     WHERE id = ? AND status IN ('running', 'queued')`,
    result.status,
    new Date().toISOString(),
    result.data ? JSON.stringify(result.data) : null,
    result.error ? `${result.error.code}: ${result.error.message}` : null,
    commandId,
  );
  const first = res.changes === 1;
  if (first && result.status === 'done' && /^workspace\.(sync|provision)$/.test(row.action)) {
    try {
      const workspaceId = (JSON.parse(row.payload_json) as { workspace_id?: unknown }).workspace_id;
      if (typeof workspaceId === 'string') {
        const now = new Date().toISOString();
        db.run('UPDATE workspaces SET last_sync_at = ?, updated_at = ? WHERE id = ?', now, now, workspaceId);
      }
    } catch {
      /* defektes Payload: last_sync_at bleibt unverändert */
    }
  }
  return { first };
}

export interface SyncLogEntry {
  id: string;
  action: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  workspace_id: string | null;
  local_path: string | null;
  machine_id: string;
  machine_name: string | null;
  requested_by: string | null;
}

/** Sync-/Provision-Verlauf eines Projekts (inkl. Fehlermeldungen des Agenten). */
export function syncLogForProject(db: Database, projectId: string, limit = 100): SyncLogEntry[] {
  const rows = db.all<
    Omit<SyncLogEntry, 'result'> & { result_json: string | null }
  >(
    `SELECT c.id, c.action, c.status, c.created_at, c.started_at, c.finished_at, c.error,
            c.result_json, c.machine_id, m.name AS machine_name,
            u.email AS requested_by,
            json_extract(c.payload_json, '$.workspace_id') AS workspace_id,
            json_extract(c.payload_json, '$.local_path') AS local_path
     FROM agent_commands c
     LEFT JOIN machines m ON m.id = c.machine_id
     LEFT JOIN users u ON u.id = c.requested_by
     WHERE c.action IN ('workspace.sync', 'workspace.provision')
       AND json_extract(c.payload_json, '$.workspace_id') IN
           (SELECT id FROM workspaces WHERE project_id = ?)
     ORDER BY c.created_at DESC
     LIMIT ?`,
    projectId,
    limit,
  );
  return rows.map(({ result_json, ...rest }) => {
    let result: Record<string, unknown> | null = null;
    if (result_json) {
      try {
        result = JSON.parse(result_json) as Record<string, unknown>;
      } catch {
        result = null;
      }
    }
    return { ...rest, result };
  });
}
