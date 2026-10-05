import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createServerContext } from '../src/index.js';
import { createApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';

export interface TestResponse<T = any> {
  status: number;
  body: { data?: T; error?: { code: string; message: string } };
  headers: Headers;
}

export interface TestServer {
  base: string;
  ctx: AppContext;
  server: Server;
  dataDir: string;
  request<T = any>(
    method: string,
    path: string,
    opts?: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<TestResponse<T>>;
  login(email: string, password: string): Promise<string>;
  /** Enrollment-Token erzeugen und Maschine einschreiben (Phase B). */
  enroll(cookie: string, name?: string): Promise<{ machineId: string; token: string }>;
  close(): Promise<void>;
}

export const TEST_ADMIN = {
  email: 'admin@devdeck.test',
  password: 'admin-pass-123',
};

/** Ephemären DevDeck-Server mit Temp-Datenbank starten. */
export async function startTestServer(
  extraEnv: Record<string, string> = {},
): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-test-'));
  const env: Record<string, string> = {
    DEVDECK_DATA_DIR: dataDir,
    DEVDECK_PORT: '0',
    DEVDECK_HOST: '127.0.0.1',
    DEVDECK_ADMIN_EMAIL: TEST_ADMIN.email,
    DEVDECK_ADMIN_PASSWORD: TEST_ADMIN.password,
    DEVDECK_BACKUP_TARGET: path.join(dataDir, 'backup-target'),
    ...extraEnv,
  };
  const ctx = createServerContext(env);
  const app = createApp(ctx);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Kein Port');
  const base = `http://127.0.0.1:${address.port}`;

  const request: TestServer['request'] = async (method, reqPath, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const res = await fetch(`${base}${reqPath}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* keine JSON-Antwort */
    }
    return { status: res.status, body, headers: res.headers };
  };

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request('POST', '/api/auth/login', { body: { email, password } });
    if (res.status !== 200) {
      throw new Error(`Login fehlgeschlagen: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const session = setCookies.find((c) => c.startsWith('dd_session='));
    if (!session) throw new Error('Kein Session-Cookie erhalten');
    return session.split(';')[0]!;
  };

  const enroll = async (
    cookie: string,
    name = 'test-machine',
  ): Promise<{ machineId: string; token: string }> => {
    const tokenRes = await request('POST', '/api/machines/enrollment-tokens', {
      cookie,
      body: { ttl_minutes: 10 },
    });
    if (tokenRes.status !== 201) {
      throw new Error(`Enrollment-Token fehlgeschlagen: ${JSON.stringify(tokenRes.body)}`);
    }
    const enrollRes = await request('POST', '/api/agent/enroll', {
      body: {
        enrollment_token: tokenRes.body.data.token,
        name,
        platform: 'linux',
        agent_version: '0.1.0',
      },
    });
    if (enrollRes.status !== 201) {
      throw new Error(`Enrollment fehlgeschlagen: ${JSON.stringify(enrollRes.body)}`);
    }
    return { machineId: enrollRes.body.data.machine_id, token: enrollRes.body.data.machine_token };
  };

  return {
    base,
    ctx,
    server,
    dataDir,
    request,
    login,
    enroll,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ctx.db.close();
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* Aufräumen ist optional */
      }
    },
  };
}
