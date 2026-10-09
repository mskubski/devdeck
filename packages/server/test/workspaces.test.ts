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
    expect(poll.body.data[0].action).toBe('workspace.sync');
    expect(poll.body.data[0].payload.workspace_id).toBe(wsId);
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
