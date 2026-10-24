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
  workspace_root: string | null;
  agent_outdated: boolean;
  /** Agent kennt `agent.update` (≥ 0.2.0) – auch wenn er nicht die allerneueste Version ist. */
  agent_can_self_update: boolean;
  /** Diagnose: Commit/Node/Startdatei des laufenden Agent-Prozesses (ab Agent 0.7.0) */
  agent_commit?: string | null;
  agent_node?: string | null;
  agent_entry?: string | null;
  /** Hinweis, wenn ein Update „erfolgreich“ war, der Agent aber noch mit alter Version läuft */
  update_warning?: string | null;
  agent_status: MachineStatus;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Hardware-/System-Inventar einer Maschine, vom Agenten gesammelt (keine Geheimnisse, nur Metadaten). */
export type InventoryLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface MachineInventory {
  collected_at: string;
  platform: string;
  hostname: string | null;
  user: string | null;
  device: {
    manufacturer?: string | null;
    model?: string | null;
    version?: string | null;
    processor?: string | null;
    serial?: string | null;
    ram_gb?: number | null;
    bios?: string | null;
  };
  os: {
    name?: string | null;
    version?: string | null;
    build?: string | null;
    language?: string | null;
    arch?: string | null;
    kernel?: string | null;
  };
  disks: Array<{ name: string; label?: string | null; total_gb: number; free_gb: number }>;
  /** Sicherheitsstatus je Plattform; `level` entscheidet über die Farbe in der Oberfläche. */
  security: Array<{ label: string; value: string; level: InventoryLevel }>;
  network: { ips: string[] };
  runtime: { boot_time?: string | null; node?: string | null };
}

export interface MachineCustomField {
  label: string;
  value: string;
}

export interface MachineDetailDto extends MachineDto {
  inventory: MachineInventory | null;
  inventory_at: string | null;
  custom_fields: MachineCustomField[];
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
  machine_id: string | null;
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
  /** Ergebnis der letzten Prüfung (Checks + Git-Zustand); null = noch nie geprüft */
  readiness?: ReadinessReport | null;
  git_state?: GitState | null;
  checked_at?: string | null;
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
  handover_id: string | null;
  git_state: Record<string, unknown> | null;
  /** 'devdeck' = in DevDeck gestartet, 'claude-code' = vom Agent aus dem Claude-Transcript erfasst */
  source?: 'devdeck' | 'claude-code';
  git_branch?: string | null;
  pr_url?: string | null;
  message_count?: number | null;
  last_activity_at?: string | null;
  user_email?: string | null;
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
export type { Environment, ProjectRole, SecretCapability, SystemRole } from './roles.js';

export interface HandoverDto {
  id: string;
  session_id: string | null;
  project_id: string;
  payload: HandoverPayload;
  validated_at: string;
  created_at: string;
}

export interface SecretDto {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  kind: SecretKind;
  environment: Environment;
  vault_reference: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_email: string | null;
  has_value: boolean;
}

export interface SecretGrantDto {
  id: string;
  secret_id: string;
  subject_type: 'member' | 'user' | 'machine' | 'role';
  subject_id: string;
  capability: SecretCapability;
  created_at: string;
  created_by: string | null;
  created_by_email: string | null;
}

export interface SecretTargetDto {
  id: string;
  secret_id: string;
  target_path: string;
  file_mode: string;
}
