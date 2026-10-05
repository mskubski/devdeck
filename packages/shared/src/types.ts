/** DevDeck – API-Datenstrukturen (DTOs) für Server, Agent und CLI. */
import type { Environment, ProjectRole, SecretCapability, SystemRole } from './roles.js';
import type { GitState, ReadinessReport } from './protocol.js';

export interface UserDto {
  id: string;
  email: string;
  display_name: string | null;
  system_role: SystemRole;
  disabled: boolean;
  created_at: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repo_remote: string | null;
  default_branch: string | null;
  created_at: string;
  archived_at: string | null;
  role?: ProjectRole;
}

export interface MemberDto {
  user_id: string;
  email: string;
  display_name: string | null;
  role: ProjectRole;
  created_at: string;
}

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export interface TaskDto {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';
export interface DecisionDto {
  id: string;
  project_id: string;
  title: string;
  rationale: string | null;
  context: string | null;
  alternative: string | null;
  status: DecisionStatus;
  created_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export type ChangelogSource = 'manual' | 'handover' | 'agent';
export interface ChangelogEntryDto {
  id: string;
  project_id: string;
  version: string | null;
  summary: string;
  body: string | null;
  source: ChangelogSource;
  session_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface KnownIssueDto {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: 'open' | 'resolved';
  severity: 'low' | 'medium' | 'high';
  created_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export type MachineStatus = 'online' | 'offline' | 'revoked';
export interface MachineDto {
  id: string;
  owner_user_id: string;
  name: string;
  platform: string;
  agent_version: string | null;
  agent_status: MachineStatus;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type WorkspaceStatus =
  | 'unknown'
  | 'provisioning'
  | 'ready'
  | 'warning'
  | 'blocked'
  | 'offline';

export interface WorkspaceDto {
  id: string;
  project_id: string;
  machine_id: string;
  owner_user_id: string;
  local_path: string;
  repo_remote: string | null;
  branch: string | null;
  status: WorkspaceStatus;
  last_git_commit: string | null;
  last_sync_at: string | null;
  last_context_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionStatus = 'open' | 'closed';
export interface CodingSessionDto {
  id: string;
  project_id: string;
  workspace_id: string | null;
  machine_id: string | null;
  user_id: string;
  agent_name: string | null;
  status: SessionStatus;
  goal: string | null;
  started_at: string;
  ended_at: string | null;
  git_state_json: string | null;
}

/** Strukturierter Handover gemäß Spezifikation §20 (Codex/Claude → DevDeck). */
export interface HandoverPayload {
  goal?: string;
  completed?: string[];
  open_items?: string[];
  decisions?: Array<{ title: string; rationale?: string }>;
  changed_files?: string[];
  commit?: string;
  changelog_summary?: string;
  notes?: string;
}

export type SecretKind = 'env' | 'file';
export interface SecretMetadataDto {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  kind: SecretKind;
  environment: Environment;
  version: number;
  vault_reference: string;
  created_at: string;
  updated_at: string;
  /** Enthält NIE den Secret Value. */
  target_path?: string | null;
  capabilities?: SecretCapability[];
}

export interface Envelope<T> {
  data: T;
}

export interface HistoryItemDto {
  kind: 'changelog' | 'decision' | 'session' | 'issue';
  id: string;
  created_at: string;
  title: string;
  summary?: string | null;
  status?: string;
}

export interface BackupDto {
  id: string;
  kind: 'system' | 'project';
  target_path: string;
  manifest_path: string | null;
  status: 'running' | 'completed' | 'failed' | 'restored';
  created_at: string;
  finished_at: string | null;
  verified_at: string | null;
  size_bytes: number | null;
  checksum: string | null;
  error: string | null;
}

export interface AuditEntryDto {
  id: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  project_id: string | null;
  machine_id: string | null;
  target_type: string | null;
  target_id: string | null;
  result: 'success' | 'failure' | 'denied';
  detail_json: string | null;
  ip: string | null;
  created_at: string;
}

export type { GitState, ReadinessReport };
