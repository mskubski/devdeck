import { AppError, type AgentCommandPayload } from '@devdeck/shared';
import type { AgentConfig } from './config.js';

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
      const res = await fetch(`${this.config.serverUrl}${apiPath}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
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

  async enroll(enrollmentToken: string, name: string): Promise<{ machine_id: string }> {
    const res = await this.request<{ machine_id: string; machine_token: string }>(
      'POST',
      '/api/agent/enroll',
      {
        auth: 'none',
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

  async heartbeat(workspaces: unknown[] = []): Promise<void> {
    const res = await this.request('POST', '/api/agent/heartbeat', {
      body: { agent_version: this.config.agentVersion, platform: process.platform, workspaces },
      timeoutMs: 10_000,
    });
    if (res.status === 401) {
      throw new AppError('UNAUTHORIZED', 'Agent-Token abgelehnt (widerrufen?)');
    }
    if (res.status >= 500) {
      throw new AppError('AGENT_OFFLINE', `Serverfehler: ${res.status}`);
    }
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
      return [];
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
    await this.request('POST', `/api/agent/commands/${commandId}/result`, { body: payload });
  }
}
