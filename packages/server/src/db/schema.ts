import type { Database } from './database.js';

/**
 * Schema-Migrationen. Reihenfolge = Versionsreihenfolge via PRAGMA user_version.
 * Jeder Eintrag ist eine abgeschlossene Version (bestehende niemals ändern).
 */
const MIGRATIONS: string[] = [
  // v1 – Identität, Projekte, Maschinen, Workspaces, Agent-Kommandos
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    system_role TEXT NOT NULL DEFAULT 'developer',
    display_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    repo_remote TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    agent_version TEXT,
    agent_status TEXT NOT NULL DEFAULT 'offline',
    last_seen_at TEXT,
    token_hash TEXT UNIQUE,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_machines_owner ON machines(owner_user_id);

  CREATE TABLE enrollment_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    local_path TEXT NOT NULL,
    repo_remote TEXT,
    branch TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_git_commit TEXT,
    last_sync_at TEXT,
    last_context_sync_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, machine_id, local_path)
  );

  CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    result_json TEXT,
    error TEXT,
    requested_by TEXT
  );
  CREATE INDEX idx_commands_machine_status ON agent_commands(machine_id, status, created_at);
  `,

  // v2 – Projektwissen (langfristige Source of Truth)
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id, status);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    rationale TEXT,
    context TEXT,
    alternative TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX idx_decisions_project ON decisions(project_id, status);

  CREATE TABLE changelog_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version TEXT,
    summary TEXT NOT NULL,
    body TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    session_id TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_changelog_project ON changelog_entries(project_id, created_at);

  CREATE TABLE known_issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    severity TEXT NOT NULL DEFAULT 'medium',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE git_metadata (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    commit_sha TEXT NOT NULL,
    branch TEXT,
    author TEXT,
    committed_at TEXT,
    message TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE coding_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    agent_name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    goal TEXT,
    handover_id TEXT,
    git_state_json TEXT
  );
  CREATE INDEX idx_codingsessions_project ON coding_sessions(project_id, status);

  CREATE TABLE handovers (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES coding_sessions(id) ON DELETE SET NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL,
    validated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE open_items (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES coding_sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  `,

    // v3 – Secret-Metadaten (Werte ausschließlich in der separaten Vault-DB),
  //       Backups (Restore von Anfang an vorgesehen), Audit-Log
  `
  CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'env',
    environment TEXT NOT NULL DEFAULT 'development',
    vault_reference TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT REFERENCES users(id),
    UNIQUE (project_id, name, environment)
  );

  CREATE TABLE secret_grants (
    id TEXT PRIMARY KEY,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT REFERENCES users(id)
  );
  CREATE INDEX idx_grants_secret ON secret_grants(secret_id, subject_type, subject_id);

  CREATE TABLE secret_targets (
    id TEXT PRIMARY KEY,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    target_path TEXT NOT NULL,
    file_mode TEXT NOT NULL DEFAULT '0600'
  );

  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'system',
    target_path TEXT NOT NULL,
    manifest_path TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL,
    finished_at TEXT,
    verified_at TEXT,
    size_bytes INTEGER,
    checksum TEXT,
    created_by TEXT REFERENCES users(id),
    error TEXT
  );

  CREATE TABLE backup_items (
    backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (backup_id, relative_path)
  );

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_label TEXT,
    action TEXT NOT NULL,
    project_id TEXT,
    machine_id TEXT,
    target_type TEXT,
    target_id TEXT,
    result TEXT NOT NULL,
    detail_json TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_log(created_at);
  CREATE INDEX idx_audit_project ON audit_log(project_id, created_at);
  `
,

  // v4 – Vault-Encrypted-Entry-Metadaten
  // (Die eigentlichen Encrypted Blobs leben in der separaten vault.db SQLite-Datei;
  // hier wird nur der Referenzzeiger gespeichert, der in vault.db als Schlüssel dient.)
  `
  CREATE TABLE vault_entries (
    id TEXT PRIMARY KEY,
    vault_reference TEXT NOT NULL UNIQUE,
    encrypted_blob BLOB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT REFERENCES users(id)
  );
  CREATE INDEX idx_vault_entries_ref ON vault_entries(vault_reference);
  `,

  // v5 – Fix: `handovers` fehlte `created_by`, obwohl routes/sessions.ts es seit
  // Einführung des Handover-Endpunkts voraussetzt (INSERT/JOIN schlugen zuvor fehl).
  `
  ALTER TABLE handovers ADD COLUMN created_by TEXT REFERENCES users(id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: Database): void {
  const row = db.get<{ user_version: number }>('PRAGMA user_version;');
  let current = row?.user_version ?? 0;
  while (current < MIGRATIONS.length) {
    const next = current + 1;
    const sql = MIGRATIONS[current];
    if (!sql) break;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${next};`);
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
    current = next;
  }
}
