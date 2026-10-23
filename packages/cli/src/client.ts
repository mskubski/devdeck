import type { CliConfig, LocalAgent } from './config.js';

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 'ERROR',
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

/** Server-API-Aufruf mit Bearer-Token. */
export async function api<T = unknown>(
  config: CliConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!config.token) throw new CliError('Nicht angemeldet. Bitte zuerst: devdeck login', 'UNAUTHORIZED');
  let res: Response;
  try {
    res = await fetch(`${config.serverUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(`Server nicht erreichbar: ${config.serverUrl}`, 'UNREACHABLE');
  }
  let parsed: Envelope<T> | null = null;
  try {
    parsed = (await res.json()) as Envelope<T>;
  } catch {
    /* kein JSON */
  }
  if (!res.ok) {
    throw new CliError(parsed?.error?.message ?? `HTTP ${res.status}`, parsed?.error?.code ?? 'HTTP');
  }
  return parsed?.data as T;
}

/** Aktion über die lokale Agent-API (127.0.0.1) ausführen. */
export async function agentAction<T = Record<string, unknown>>(
  agent: LocalAgent | null,
  action: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (!agent) throw new CliError('Kein lokaler DevDeck Agent konfiguriert (agent.json fehlt).', 'AGENT_OFFLINE');
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${agent.port}/actions/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevDeck-Local-Token': agent.token },
      body: JSON.stringify({ payload }),
    });
  } catch {
    throw new CliError('Lokaler DevDeck Agent läuft nicht (Port ' + agent.port + ').', 'AGENT_OFFLINE');
  }
  const parsed = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok) throw new CliError(parsed?.error?.message ?? `Agent-Fehler ${res.status}`, parsed?.error?.code ?? 'AGENT');
  return parsed?.data as T;
}
