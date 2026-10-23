import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** CLI-Konfiguration (~/.devdeck/config.json, Modus 0600): Server-URL + Benutzer-Token. */
export interface CliConfig {
  serverUrl: string;
  token: string | null;
  email: string | null;
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return env.DEVDECK_CLI_CONFIG ?? path.join(os.homedir(), '.devdeck', 'config.json');
}

export function agentConfigPath(env: NodeJS.ProcessEnv): string {
  return env.DEVDECK_AGENT_CONFIG ?? path.join(os.homedir(), '.devdeck', 'agent.json');
}

export function loadConfig(env: NodeJS.ProcessEnv): CliConfig {
  let raw: Partial<CliConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(env), 'utf8')) as Partial<CliConfig>;
  } catch {
    /* noch nicht angemeldet */
  }
  return {
    serverUrl: (env.DEVDECK_SERVER ?? raw.serverUrl ?? 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    token: env.DEVDECK_TOKEN || raw.token || null,
    email: raw.email ?? null,
  };
}

export function saveConfig(env: NodeJS.ProcessEnv, config: CliConfig): void {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export interface LocalAgent {
  port: number;
  token: string;
}

export function loadLocalAgent(env: NodeJS.ProcessEnv): LocalAgent | null {
  try {
    const raw = JSON.parse(fs.readFileSync(agentConfigPath(env), 'utf8')) as {
      localPort?: number;
      localToken?: string;
    };
    if (!raw.localToken) return null;
    return { port: Number(raw.localPort ?? 7420), token: raw.localToken };
  } catch {
    return null;
  }
}
