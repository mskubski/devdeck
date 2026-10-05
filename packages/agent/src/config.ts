import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Laufzeit-Konfiguration des DevDeck Agent (enthält Maschinen-Token, Modus 0600). */
export interface AgentConfig {
  serverUrl: string;
  machineId: string | null;
  machineToken: string | null;
  localToken: string;
  workspaceRoot: string;
  localPort: number;
  agentVersion: string;
}

export const AGENT_VERSION = '0.1.0';

export function defaultConfigPath(): string {
  return process.env.DEVDECK_AGENT_CONFIG ?? path.join(os.homedir(), '.devdeck', 'agent.json');
}

export function defaultWorkspaceRoot(): string {
  return process.env.DEVDECK_WORKSPACE_ROOT ?? path.join(os.homedir(), 'Development');
}

export function loadAgentConfig(configPath = defaultConfigPath()): AgentConfig | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AgentConfig>;
    return {
      serverUrl: (raw.serverUrl ?? 'http://127.0.0.1:7400').replace(/\/+$/, ''),
      machineId: raw.machineId ?? null,
      machineToken: raw.machineToken ?? null,
      localToken: raw.localToken ?? '',
      workspaceRoot: raw.workspaceRoot ?? defaultWorkspaceRoot(),
      localPort: Number(raw.localPort ?? 7420),
      agentVersion: AGENT_VERSION,
    };
  } catch {
    return null;
  }
}

export function saveAgentConfig(config: AgentConfig, configPath = defaultConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* Windows kennt keine POSIX-Modi */
  }
}
