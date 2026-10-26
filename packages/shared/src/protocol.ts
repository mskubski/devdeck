/** DevDeck – Agent-Protokoll: exakte Action-Allowlist und Kommando-Strukturen. */

/** Die EINZIG erlaubten Agent-Aktionen. Keine generische Remote-Shell. */
export const AGENT_ACTIONS = [
  'workspace.status',
  'workspace.sync',
  'workspace.provision',
  'workspace.deploy',
  'context.refresh',
  'env.refresh',
  'dependencies.install',
  'editor.open',
  'terminal.open',
  'coding_agent.start',
  'agent.configure',
  'agent.update',
  'agent.autostart',
  'patches.install',
  'project.import',
] as const;

/** Aktuelle Agent-Version; ältere Agenten kennen neuere Aktionen nicht und gelten als veraltet. */
export const CURRENT_AGENT_VERSION = '0.15.0';

function versionParts(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isAgentOutdated(version: string | null | undefined): boolean {
  if (!version) return true;
  return compareVersions(version, CURRENT_AGENT_VERSION) < 0;
}

/** Ab dieser Agent-Version existiert die Aktion `agent.update` (Selbst-Update). */
export const MIN_SELF_UPDATE_VERSION = '0.2.0';

/** Ab welcher Agent-Version eine (neuere) Aktion existiert; ältere Agenten lehnen sie ab. */
export const MIN_AGENT_VERSION_FOR_ACTION: Partial<Record<string, string>> = {
  'project.import': '0.4.0',
  'workspace.deploy': '0.8.0',
  'agent.autostart': '0.14.0',
  'patches.install': '0.15.0',
};

export function agentSupportsAction(version: string | null | undefined, action: string): boolean {
  const min = MIN_AGENT_VERSION_FOR_ACTION[action];
  if (!min) return true;
  if (!version) return false;
  return compareVersions(version, min) >= 0;
}

export function supportsSelfUpdate(version: string | null | undefined): boolean {
  if (!version) return false;
  return compareVersions(version, MIN_SELF_UPDATE_VERSION) >= 0;
}

/** Höchstzahl Updates je Installationsauftrag und erlaubtes Format einer Update-Kennung (kein Bindestrich am Anfang → keine Optionen). */
export const MAX_PATCH_INSTALL_IDS = 100;
export const PATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:+@~/=()-]{0,119}$/;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

export function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === 'string' && (AGENT_ACTIONS as readonly string[]).includes(value);
}

export type AgentCommandStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface AgentCommandPayload {
  id: string;
  action: AgentAction;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
}

export interface AgentCommandResultData {
  status: 'done' | 'failed';
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** Readiness-Status einzelner Checks und Gesamt (Spezifikation §17). */
export type ReadinessLevel = 'OK' | 'WARNING' | 'BLOCKED';
export type ReadinessOverall = 'READY' | 'WARNING' | 'BLOCKED';

export interface ReadinessCheck {
  name: string;
  status: ReadinessLevel;
  detail?: string;
}

export interface ReadinessReport {
  overall: ReadinessOverall;
  checks: ReadinessCheck[];
}

/** Heartbeat des Agenten. */
export interface HeartbeatRequest {
  agent_version: string;
  platform: string;
  workspace_root?: string;
  /** Diagnose: Commit/Node/Startdatei des laufenden Agent-Prozesses */
  agent_commit?: string | null;
  agent_node?: string | null;
  agent_entry?: string | null;
  /** Hardware-/System-Inventar (ab Agent 0.9.0, nur bei Änderung/alle 15 Minuten) */
  inventory?: import('./types.js').MachineInventory;
  /** Installierte Software (ab Agent 0.11.0, beim Start und danach stündlich) */
  applications?: { collected_at: string; items: import('./types.js').MachineApplication[] };
  /** Patch-Stand (ab Agent 0.12.0, beim Start und danach alle 6 Stunden) */
  patches?: import('./types.js').MachinePatches;
  /** Fehlerprotokolle seit der letzten Meldung (ab Agent 0.13.0, alle 15 Minuten) */
  logs?: { collected_at: string; entries: import('./types.js').MachineLogEntry[]; notes: string[] };
  /** Autostart-Zustand des Agents (ab Agent 0.14.0, beim Start und danach stündlich) */
  autostart?: import('./types.js').MachineAutostart;
  workspaces?: Array<{
    workspace_id?: string;
    project?: string;
    local_path: string;
    branch?: string | null;
    status?: string;
  }>;
}

/** Enrollment: Agent erhält einmalig Maschinen-Token. */
export interface EnrollRequest {
  enrollment_token: string;
  name: string;
  platform: string;
  agent_version: string;
}

export interface EnrollResponse {
  machine_id: string;
  machine_token: string;
  server_time: string;
}

/** Git-Zustand eines Workspaces, vom Agenten gemeldet. */
export interface GitState {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  files: string[];
  author?: string | null;
  committed_at?: string | null;
  message?: string | null;
}

export const AGENT_PROTOCOL_VERSION = 1;
