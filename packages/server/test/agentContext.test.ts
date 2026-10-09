import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Agent-Protokoll: Context-Builder + Secret-Projektion (Phase F/G)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;
  let workspaceId: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);

    const project = await srv.request('POST', '/api/projects', {
      cookie,
      body: { name: 'WebApp', description: 'Testprojekt', repo_remote: 'https://example.com/pf.git' },
    });
    projectId = project.body.data.id;

    const enrolled = await srv.enroll(cookie, 'Alice-PC');
    machineId = enrolled.machineId;
    machineToken = enrolled.token;

    const workspace = await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: { local_path: '/home/alice/Development/WebApp', machine_id: machineId },
    });
    expect(workspace.status).toBe(201);
    workspaceId = workspace.body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  it('context/write erzeugt die vier .devdeck-Dateien aus SQLite und aktualisiert last_context_sync_at', async () => {
    await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'Login-Flow fixen', priority: 3 },
    });

    const res = await srv.request('POST', '/api/agent/context/write', {
      token: machineToken,
      body: { workspace_id: workspaceId, local_path: '/home/alice/Development/WebApp' },
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'CHANGELOG_RECENT.md',
      'CONTEXT.md',
      'CURRENT_STATE.md',
      'SECRETS.md',
    ]);
    expect(res.body.data['CONTEXT.md']).toContain('WebApp');
    expect(res.body.data['CURRENT_STATE.md']).toContain('Login-Flow fixen');

    const ws = srv.ctx.db.get<{ last_context_sync_at: string | null }>(
      'SELECT last_context_sync_at FROM workspaces WHERE id = ?',
      workspaceId,
    );
    expect(ws?.last_context_sync_at).toBeTruthy();
  });

  it('context/write verweigert eine Maschine, die nicht Eigentümer des Workspaces ist', async () => {
    const other = await srv.enroll(cookie, 'Fremde-Maschine');
    const res = await srv.request('POST', '/api/agent/context/write', {
      token: other.token,
      body: { workspace_id: workspaceId, local_path: '/x' },
    });
    expect(res.status).toBe(403);
  });

  it('secrets/fetch projiziert nur Werte, für die der Maschinenbesitzer secret.use hat', async () => {
    const secret = await srv.request('POST', `/api/projects/${projectId}/secrets`, {
      cookie,
      body: { name: 'SUPABASE_URL', kind: 'env', environment: 'development' },
    });
    const secretId = secret.body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie,
      body: { value: 'https://xyz.supabase.co' },
    });

    const res = await srv.request('POST', '/api/agent/secrets/fetch', {
      token: machineToken,
      body: { workspace_id: workspaceId, local_path: '/x', include: ['env', 'files'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.env).toEqual({ SUPABASE_URL: 'https://xyz.supabase.co' });

    const audits = srv.ctx.db.all<{ detail_json: string | null }>(
      `SELECT detail_json FROM audit_log WHERE action = 'secret.projection'`,
    );
    for (const row of audits) {
      expect(row.detail_json ?? '').not.toContain('xyz.supabase.co');
    }
  });

  it('secrets/check liefert Versionsmetadaten ohne Werte', async () => {
    await srv.request('POST', `/api/projects/${projectId}/secrets`, {
      cookie,
      body: { name: 'API_KEY', kind: 'env', environment: 'development' },
    });
    const res = await srv.request('POST', '/api/agent/secrets/check', {
      token: machineToken,
      body: { workspace_id: workspaceId, local_path: '/x' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.secrets).toEqual([{ name: 'API_KEY', kind: 'env', version: 1 }]);
  });
});
