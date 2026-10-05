import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';

export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditInput {
  actor_type: 'user' | 'agent' | 'system';
  actor_id?: string | null;
  actor_label?: string | null;
  action: string;
  project_id?: string | null;
  machine_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  result: AuditResult;
  /** NIE Secret-Values enthalten! Nur nicht-sensible Metadaten. */
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Blacklist – falls doch einmal ein Wert durchrutscht, wird er rotiert. */
const SENSITIVE_KEY = /secret|password|token|value|credential|apikey|api_key|key$/i;

function sanitizeDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    cleaned[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : v;
  }
  return JSON.stringify(cleaned);
}

/** Sicherheitsrelevantes Audit-Log (Spezifikation §25). Niemals Secret-Values. */
export function audit(db: Database, input: AuditInput): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO audit_log
       (id, actor_type, actor_id, actor_label, action, project_id, machine_id,
        target_type, target_id, result, detail_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.actor_type,
    input.actor_id ?? null,
    input.actor_label ?? null,
    input.action,
    input.project_id ?? null,
    input.machine_id ?? null,
    input.target_type ?? null,
    input.target_id ?? null,
    input.result,
    sanitizeDetail(input.detail),
    input.ip ?? null,
    new Date().toISOString(),
  );
  return id;
}
