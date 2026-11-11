import { AppError, type AgentCommandPayload, type MachineApplication, type MachineAutostart, type MachineInventory, type MachineLogEntry, type MachinePatches, type MachineRemote, type ProbeResult, type ProbeSpec } from '@devdeck/shared';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentConfig } from './config.js';
import { getRunningHead } from './runtimeInfo.js';

/** Verständliche Fehlermeldung statt „fetch failed“ / „This operation was aborted“. */
export function unreachable(serverUrl: string, err: unknown, timedOut: boolean): AppError {
  const raw = (err as { cause?: { code?: string; message?: string; errors?: Array<{ code?: string }> } })?.cause;
  // Bei Dual-Stack (IPv4+IPv6) liegt der Code in einer AggregateError
  const cause = raw ? { code: raw.code ?? raw.errors?.[0]?.code, message: raw.message } : undefined;
  const reason = timedOut
    ? 'Zeitüberschreitung – keine Antwort (Firewall/anderes Netzwerk/falsche IP?)'
    : cause?.code === 'ECONNREFUSED'
      ? 'Verbindung abgelehnt (läuft der Server? stimmt der Port?)'
      : cause?.code === 'ENOTFOUND'
        ? 'Hostname nicht auflösbar'
        : cause?.code === 'EHOSTUNREACH' || cause?.code === 'ENETUNREACH'
          ? 'Host/Netzwerk nicht erreichbar'
          : (cause?.message ?? (err instanceof Error ? err.message : String(err)));
  return new AppError('AGENT_OFFLINE', `Server nicht erreichbar: ${serverUrl} – ${reason}`);
}

/** HTTP-Client des Agenten zum DevDeck Server (nur ausgehende Verbindungen). */
export class ServerClient {
  constructor(private readonly config: AgentConfig) {}

  get serverUrl(): string {
    return this.config.serverUrl;
  }

  isEnrolled(): boolean {
    return Boolean(this.config.machineToken && this.config.machineId);
  }

  async request<T = unknown>(
    method: string,
    apiPath: string,
    options: { body?: unknown; auth?: 'machine' | 'none'; timeoutMs?: number } = {},
  ): Promise<{ status: number; data?: T; error?: { code: string; message: string } }> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth !== 'none' && this.config.machineToken) {
      headers['Authorization'] = `Bearer ${this.config.machineToken}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 40_000);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.serverUrl}${apiPath}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
      } catch (err) {
        throw unreachable(this.config.serverUrl, err, controller.signal.aborted);
      }
      let body: any = null;
      if (res.status !== 204) {
        try {
          body = await res.json();
        } catch {
          body = null;
        }
      }
      return { status: res.status, data: body?.data as T, error: body?.error };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Datei als Rohdaten hochladen (Prüfsumme im Header, der Server prüft sie beim Empfang). Für Backup-Replikation. */
  async putFile(apiPath: string, file: string, sha256: string, size: number, timeoutMs = 2 * 3_600_000): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.serverUrl}${apiPath}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${this.config.machineToken ?? ''}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(size),
            'X-Sha256': sha256,
          },
          body: fs.createReadStream(file) as never,
          duplex: 'half',
          signal: controller.signal,
        } as RequestInit & { duplex: 'half' });
      } catch (err) {
        throw unreachable(this.config.serverUrl, err, controller.signal.aborted);
      }
      if (res.status >= 400) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new AppError('INTERNAL', body?.error?.message ?? `Upload fehlgeschlagen (HTTP ${res.status})`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Datei herunterladen und dabei Größe und Prüfsumme prüfen (bei Abweichung wird die Zieldatei gelöscht). */
  async getFile(apiPath: string, dest: string, expect: { sha256: string; bytes: number }, timeoutMs = 2 * 3_600_000): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.serverUrl}${apiPath}`, {
          headers: { Authorization: `Bearer ${this.config.machineToken ?? ''}` },
          signal: controller.signal,
        });
      } catch (err) {
        throw unreachable(this.config.serverUrl, err, controller.signal.aborted);
      }
      if (res.status >= 400 || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new AppError('INTERNAL', body?.error?.message ?? `Download fehlgeschlagen (HTTP ${res.status})`);
      }
      const hash = createHash('sha256');
      let received = 0;
      try {
        await pipeline(
          Readable.fromWeb(res.body as never),
          new Transform({
            transform(chunk: Buffer, _enc, cb) {
              received += chunk.length;
              hash.update(chunk);
              cb(null, chunk);
            },
          }),
          fs.createWriteStream(dest, { mode: 0o600 }),
        );
        if (received !== expect.bytes || hash.digest('hex') !== expect.sha256) {
          throw new AppError('INTERNAL', 'Datei beschädigt übertragen (Größe oder Prüfsumme stimmt nicht)');
        }
      } catch (err) {
        fs.rmSync(dest, { force: true });
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async enroll(enrollmentToken: string, name: string): Promise<{ machine_id: string }> {
    const res = await this.request<{ machine_id: string; machine_token: string }>(
      'POST',
      '/api/agent/enroll',
      {
        auth: 'none',
        timeoutMs: 15_000,
        body: {
          enrollment_token: enrollmentToken,
          name,
          platform: process.platform,
          agent_version: this.config.agentVersion,
        },
      },
    );
    if (res.status !== 201 || !res.data) {
      throw new AppError('UNAUTHORIZED', res.error?.message ?? 'Enrollment fehlgeschlagen');
    }
    this.config.machineId = res.data.machine_id;
    this.config.machineToken = res.data.machine_token;
    return { machine_id: res.data.machine_id };
  }

  async heartbeat(
    workspaces: unknown[] = [],
    inventory?: MachineInventory,
    applications?: { collected_at: string; items: MachineApplication[] },
    patches?: MachinePatches,
    logs?: { collected_at: string; entries: MachineLogEntry[]; notes: string[] },
    autostart?: MachineAutostart,
    probeResults?: ProbeResult[],
    remote?: MachineRemote,
  ): Promise<{ probes: ProbeSpec[] }> {
    const res = await this.request<{ probes?: ProbeSpec[] }>('POST', '/api/agent/heartbeat', {
      body: {
        agent_version: this.config.agentVersion,
        platform: process.platform,
        workspace_root: this.config.workspaceRoot,
        workspaces,
        ...(inventory ? { inventory } : {}),
        ...(applications ? { applications } : {}),
        ...(patches ? { patches } : {}),
        ...(logs ? { logs } : {}),
        ...(autostart ? { autostart } : {}),
        ...(remote ? { remote } : {}),
        ...(probeResults?.length ? { probe_results: probeResults } : {}),
        // Diagnose: aus welchem Code/Ordner läuft dieser Agent? (hilft, wenn ein Update „nicht ankommt“)
        agent_commit: getRunningHead(),
        agent_node: process.version,
        agent_entry: process.argv[1] ?? null,
      },
      timeoutMs: 10_000,
    });
    if (res.status === 401) {
      throw new AppError('UNAUTHORIZED', 'Agent-Token abgelehnt (widerrufen?)');
    }
    if (res.status >= 400) {
      throw new AppError('AGENT_OFFLINE', `Serverfehler: HTTP ${res.status}`);
    }
    return { probes: Array.isArray(res.data?.probes) ? res.data!.probes! : [] };
  }

  async pollCommands(waitSeconds = 25): Promise<AgentCommandPayload[]> {
    const res = await this.request<AgentCommandPayload[]>(
      'GET',
      `/api/agent/commands?wait=${waitSeconds}`,
      { timeoutMs: waitSeconds * 1000 + 10_000 },
    );
    if (res.status === 204) return [];
    if (res.status !== 200 || !res.data) {
      if (res.status === 401) throw new AppError('UNAUTHORIZED', 'Agent-Token ungültig');
      throw new AppError(
        'INTERNAL',
        `Unerwartete Server-Antwort beim Command-Poll: HTTP ${res.status}${res.error ? ` – ${res.error.message}` : ''}`,
      );
    }
    return res.data;
  }

  async sendResult(
    commandId: string,
    payload: {
      status: 'done' | 'failed';
      data?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  ): Promise<void> {
    const res = await this.request('POST', `/api/agent/commands/${commandId}/result`, {
      body: payload,
    });
    if (res.status >= 400) {
      throw new AppError(
        'INTERNAL',
        `Ergebnis für Befehl ${commandId} konnte nicht gemeldet werden: HTTP ${res.status}${res.error ? ` – ${res.error.message}` : ''}`,
      );
    }
  }
}
