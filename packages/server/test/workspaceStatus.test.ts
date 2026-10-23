import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Workspace-Status: Ursache sichtbar, automatische Prüfung', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;

  const statusCommands = (wsId?: string) =>
    srv.ctx.db.all<{ id: string; status: string; payload_json: string }>(
      `SELECT id, status, payload_json FROM agent_commands WHERE action = 'workspace.status'${wsId ? ` AND json_extract(payload_json,'$.workspace_id') = '${wsId}'` : ''}`,
    );

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    const m = await srv.enroll(cookie, 'pc');
    machineId = m.machineId;
    machineToken = m.token;
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', agent_version='0.5.0', platform='linux', workspace_root='/data' WHERE id=?`, machineId);
  });
  afterEach(async () => {
    await srv.close();
  });

  const register = async (p = '/data/app') =>
    (await srv.request('POST', `/api/projects/${projectId}/workspaces`, { cookie, body: { machine_id: machineId, local_path: p } })).body.data.id as string;

  it('Registrieren löst sofort eine Prüfung aus (statt dauerhaft „unknown“)', async () => {
    const id = await register();
    expect(statusCommands(id)).toHaveLength(1);
    // nicht doppelt anstoßen
    await srv.request('PATCH', `/api/workspaces/${id}`, { cookie, body: { branch: 'main' } });
    expect(statusCommands(id)).toHaveLength(1);
  });

  it('Heartbeat stößt Prüfungen für nie geprüfte Workspaces an; geprüfte nicht', async () => {
    const id = await register();
    srv.ctx.db.run(`DELETE FROM agent_commands`);
    const hb = () => srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.5.0', workspaces: [] } });
    await hb();
    expect(statusCommands(id)).toHaveLength(1);
    await hb(); // schon eine wartende → keine zweite
    expect(statusCommands(id)).toHaveLength(1);

    srv.ctx.db.run(`DELETE FROM agent_commands`);
    srv.ctx.db.run(`UPDATE workspaces SET checked_at = ? WHERE id = ?`, new Date().toISOString(), id);
    await hb();
    expect(statusCommands(id)).toHaveLength(0);
  });

  it('Statusbericht speichert Checks und Git-Zustand; die API liefert sie mit der Workspace-Liste', async () => {
    const id = await register();
    const readiness = { overall: 'WARNING', checks: [{ name: 'GitHub', status: 'WARNING', detail: '7 lokale Commits nicht gepusht' }] };
    const git = { branch: 'main', commit: 'abc', dirty: false, ahead: 7, behind: 0, files: [] };
    const rep = await srv.request('POST', `/api/agent/workspaces/${id}/status`, { token: machineToken, body: { readiness, git } });
    expect(rep.body.data.status).toBe('warning');
    const list = (await srv.request('GET', `/api/projects/${projectId}/workspaces`, { cookie })).body.data;
    expect(list[0]).toMatchObject({ status: 'warning', readiness, git_state: git });
    expect(list[0].checked_at).toBeTruthy();
    expect(list[0].readiness_json).toBeUndefined();
  });

  it('„Prüfen“ beauftragt workspace.status ohne zu synchronisieren', async () => {
    const id = await register();
    srv.ctx.db.run(`DELETE FROM agent_commands`);
    const res = await srv.request('POST', `/api/workspaces/${id}/check`, { cookie });
    expect(res.status).toBe(202);
    expect(statusCommands(id)).toHaveLength(1);
    expect(srv.ctx.db.get(`SELECT 1 FROM agent_commands WHERE action = 'workspace.sync'`)).toBeUndefined();
  });
});
