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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ablaufende Commands markieren. */
export function sweepExpiredCommands(db: Database): number {
  const now = new Date().toISOString();
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
  const row = db.get<{ status: string; machine_id: string }>(
    'SELECT status, machine_id FROM agent_commands WHERE id = ?',
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
  return { first: res.changes === 1 };
}
