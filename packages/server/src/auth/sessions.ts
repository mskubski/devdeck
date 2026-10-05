import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { generateToken, hashToken } from './tokens.js';

/** Browser-Sessionen: Token nur gehasht, serverseitig widerrufbar (Entscheidung A6). */
export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface CreatedSession {
  session: SessionRecord;
  token: string;
}

export function createSession(
  db: Database,
  userId: string,
  ttlMs: number,
  meta: { user_agent?: string | null; ip?: string | null } = {},
): CreatedSession {
  const token = generateToken();
  const now = new Date();
  const session: SessionRecord = {
    id: randomUUID(),
    user_id: userId,
    token_hash: hashToken(token),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    revoked_at: null,
  };
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    session.id,
    session.user_id,
    session.token_hash,
    session.created_at,
    session.expires_at,
    meta.user_agent ?? null,
    meta.ip ?? null,
  );
  return { session, token };
}

/** Session per Plaintext-Token auflösen; null bei ungültig/abgelaufen/widerrufen. */
export function findValidSession(db: Database, token: string): SessionRecord | null {
  if (!token) return null;
  const row = db.get<SessionRecord>(
    `SELECT id, user_id, token_hash, created_at, expires_at, revoked_at
     FROM sessions WHERE token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

export function revokeSession(db: Database, token: string): void {
  db.run(
    `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
    new Date().toISOString(),
    hashToken(token),
  );
}

export function revokeAllUserSessions(db: Database, userId: string): void {
  db.run(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    new Date().toISOString(),
    userId,
  );
}
