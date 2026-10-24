import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Phase C: Workspace Registry (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const project = await srv.request('POST', '/api/projects', {
      cookie,
      body: { name: 'WebApp' },
    });
    projectId = project.body.data.id;
    const enrolled = await srv.enroll(cookie, 'Registrar-Machine');
    machineId = enrolled.machineId;
    machineToken = enrolled.token;
  });
  afterEach(async () => {
    await srv.close();
  });

  it('registriert Workspaces mit local_path und verhindert Duplikate', async () => {
    const first = await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: {
        local_path: '/home/m/Development/WebApp',
        machine_id: machineId,
        repo_remote: 'https://example.com/p.git',
        branch: 'main',
      },
    });
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('unknown');

    const dup = await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: { local_path: '/home/m/Development/WebApp', machine_id: machineId },
    });
    expect(dup.status).toBe(409);
  });

  it('listet Workspaces pro Projekt nur für Mitglieder', async () => {
    await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: { local_path: '/home/m/Development/WebApp', machine_id: machineId },
    });
    const list = await srv.request('GET', `/api/projects/${projectId}/workspaces`, { cookie });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    await srv.request('POST', '/api/users', {
      cookie,
      body: { email: 'fremd2@devdeck.test', password: 'fremd-pass-123' },
    });
    const foreign = await srv.login('fremd2@devdeck.test', 'fremd-pass-123');
    const denied = await srv.request('GET', `/api/projects/${projectId}/workspaces`, {
      cookie: foreign,
    });
    expect(denied.status).toBe(403);
  });

  async function registerWorkspace(): Promise<string> {
    const res = await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: { local_path: '/home/m/Development/WebApp', machine_id: machineId },
    });
    return res.body.data.id;
  }

  it('beauftragt sync als Command an die Online-Maschine', async () => {
    const wsId = await registerWorkspace();
    const res = await srv.request('POST', `/api/workspaces/${wsId}/sync`, { cookie });
    expect(res.status).toBe(202);
    expect(res.body.data.command_id).toBeTruthy();

    const poll = await srv.request('GET', '/api/agent/commands?wait=0', { token: machineToken });
    expect(poll.status).toBe(200);
    const sync = poll.body.data.find((c: any) => c.action === 'workspace.sync');
    expect(sync.payload.workspace_id).toBe(wsId);
  });

  it('Sync-Log zeigt Fehler und setzt last_sync_at nur bei Erfolg', async () => {
    const wsId = await registerWorkspace();
    const first = await srv.request('POST', `/api/workspaces/${wsId}/sync`, { cookie });
    const second = await srv.request('POST', `/api/workspaces/${wsId}/sync`, { cookie });
    const poll = await srv.request('GET', '/api/agent/commands?wait=0', { token: machineToken });
    expect(poll.body.data.filter((c: any) => c.action === 'workspace.sync')).toHaveLength(2);

    await srv.request('POST', `/api/agent/commands/${first.body.data.command_id}/result`, {
      token: machineToken,
      body: { status: 'failed', error: { code: 'FORBIDDEN', message: 'Pfad außerhalb Root' } },
    });
    let log = await srv.request('GET', `/api/projects/${projectId}/sync-log`, { cookie });
    expect(log.status).toBe(200);
    const failed = log.body.data.find((e: any) => e.id === first.body.data.command_id);
    expect(failed).toMatchObject({ status: 'failed', local_path: '/home/m/Development/WebApp' });
    expect(failed.error).toContain('Pfad außerhalb Root');
    let ws = await srv.request('GET', `/api/workspaces/${wsId}`, { cookie });
    expect(ws.body.data.last_sync_at).toBeNull();

    await srv.request('POST', `/api/agent/commands/${second.body.data.command_id}/result`, {
      token: machineToken,
      body: { status: 'done', data: { steps: [] } },
    });
    log = await srv.request('GET', `/api/projects/${projectId}/sync-log`, { cookie });
    expect(log.body.data.find((e: any) => e.id === second.body.data.command_id).status).toBe('done');
    ws = await srv.request('GET', `/api/workspaces/${wsId}`, { cookie });
    expect(ws.body.data.last_sync_at).toBeTruthy();
  });

  it('verweigert sync an Offline-Maschinen (AGENT_OFFLINE)', async () => {
    const wsId = await registerWorkspace();
    srv.ctx.db.run("UPDATE machines SET agent_status = 'offline' WHERE id = ?", machineId);
    const res = await srv.request('POST', `/api/workspaces/${wsId}/sync`, { cookie });
    expect(res.status).toBe(503);
    expect(res.body.error!.code).toBe('AGENT_OFFLINE');
  });

  it('erzwingt confirm für provision', async () => {
    const wsId = await registerWorkspace();
    const without = await srv.request('POST', `/api/workspaces/${wsId}/provision`, {
      cookie,
      body: {},
    });
    expect(without.status).toBe(428);

    const withConfirm = await srv.request('POST', `/api/workspaces/${wsId}/provision`, {
      cookie,
      body: { confirm: true },
    });
    expect(withConfirm.status).toBe(202);
  });

  it('protokolliert Sync-/Provision-Aufträge im Audit', async () => {
    const wsId = await registerWorkspace();
    await srv.request('POST', `/api/workspaces/${wsId}/sync`, { cookie });
    const entries = srv.ctx.db.all<{ action: string }>(
      `SELECT action FROM audit_log WHERE action IN ('workspace.sync.request', 'workspace.provision.request')`,
    );
    expect(entries.length).toBe(1);
  });
});

describe('Workspace Deploy (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;
  let wsId: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const project = await srv.request('POST', '/api/projects', { cookie, body: { name: 'Helferle', default_branch: 'main' } });
    projectId = project.body.data.id;
    const enrolled = await srv.enroll(cookie, 'helferle-vm');
    machineId = enrolled.machineId;
    machineToken = enrolled.token;
    srv.ctx.db.run(`UPDATE machines SET agent_version = '0.8.0' WHERE id = ?`, machineId);
    const ws = await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: { local_path: '/home/k/Development/helferle', machine_id: machineId },
    });
    wsId = ws.body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  it('verlangt Bestätigung', async () => {
    const res = await srv.request('POST', `/api/workspaces/${wsId}/deploy`, { cookie });
    expect(res.status).toBe(428);
  });

  it('beauftragt workspace.deploy mit Branch, schreibt Audit und erscheint im Sync-Log', async () => {
    const res = await srv.request('POST', `/api/workspaces/${wsId}/deploy`, { cookie, body: { confirm: true } });
    expect(res.status).toBe(202);
    const poll = await srv.request('GET', '/api/agent/commands?wait=0', { token: machineToken });
    const cmd = poll.body.data.find((c: any) => c.action === 'workspace.deploy');
    expect(cmd.payload).toMatchObject({ workspace_id: wsId, local_path: '/home/k/Development/helferle' });
    expect(srv.ctx.db.get(`SELECT 1 FROM audit_log WHERE action = 'workspace.deploy.request'`)).toBeTruthy();
    const log = await srv.request('GET', `/api/projects/${projectId}/sync-log`, { cookie });
    expect(log.body.data.some((e: any) => e.action === 'workspace.deploy')).toBe(true);
  });

  it('lehnt ein zweites paralleles Deploy ab', async () => {
    await srv.request('POST', `/api/workspaces/${wsId}/deploy`, { cookie, body: { confirm: true } });
    const again = await srv.request('POST', `/api/workspaces/${wsId}/deploy`, { cookie, body: { confirm: true } });
    expect(again.status).toBe(409);
  });

  it('lehnt Agents ohne Deploy-Funktion ab', async () => {
    srv.ctx.db.run(`UPDATE machines SET agent_version = '0.7.0' WHERE id = ?`, machineId);
    const res = await srv.request('POST', `/api/workspaces/${wsId}/deploy`, { cookie, body: { confirm: true } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('0.7.0');
  });

  it('verlangt Maintainer-Rechte', async () => {
    await srv.request('POST', '/api/users', { cookie, body: { email: 'dev@devdeck.test', password: 'dev-pass-123456' } });
    const users = srv.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'dev@devdeck.test'`)!;
    srv.ctx.db.run(
      `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'developer', ?)`,
      projectId, users.id, new Date().toISOString(),
    );
    const devCookie = await srv.login('dev@devdeck.test', 'dev-pass-123456');
    const res = await srv.request('POST', `/api/workspaces/${wsId}/deploy`, { cookie: devCookie, body: { confirm: true } });
    expect(res.status).toBe(403);
  });
});
