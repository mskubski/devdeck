import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { sweepExpiredCommands } from '../src/services/provisioning.js';

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

describe('Agent-Diagnose und Update-Verifikation', () => {
  let srv: TestServer;
  let cookie: string;
  let machineId: string;
  let machineToken: string;
  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const m = await srv.enroll(cookie, 'pc');
    machineId = m.machineId;
    machineToken = m.token;
  });
  afterEach(async () => {
    await srv.close();
  });
  const beat = (body: object) => srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body });
  const machine = async () => (await srv.request('GET', '/api/machines', { cookie })).body.data.find((x: any) => x.id === machineId);

  it('Heartbeat speichert Commit, Node und Startdatei des Agent-Prozesses', async () => {
    await beat({ agent_version: '0.7.0', agent_commit: 'abc1234', agent_node: 'v20.20.2', agent_entry: '/home/k/devdeck/packages/agent/dist/index.js' });
    expect(await machine()).toMatchObject({ agent_version: '0.7.0', agent_commit: 'abc1234', agent_node: 'v20.20.2', agent_entry: '/home/k/devdeck/packages/agent/dist/index.js' });
  });

  it('Versionswechsel stößt für alle Workspaces der Maschine eine neue Prüfung an (frische Fakten)', async () => {
    const projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'P' } })).body.data.id;
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', platform='linux', workspace_root='/data', agent_version='0.5.0' WHERE id=?`, machineId);
    const wsId = (await srv.request('POST', `/api/projects/${projectId}/workspaces`, { cookie, body: { machine_id: machineId, local_path: '/data/a' } })).body.data.id;
    srv.ctx.db.run(`UPDATE workspaces SET checked_at = ? WHERE id = ?`, new Date().toISOString(), wsId);
    srv.ctx.db.run('DELETE FROM agent_commands');
    await beat({ agent_version: '0.5.0' }); // gleiche Version → nichts
    expect(srv.ctx.db.all(`SELECT 1 FROM agent_commands WHERE action = 'workspace.status'`)).toHaveLength(0);
    await beat({ agent_version: '0.7.0' }); // neue Version → Prüfung
    expect(srv.ctx.db.all(`SELECT 1 FROM agent_commands WHERE action = 'workspace.status'`)).toHaveLength(1);
  });

  it('hängende running-Aufträge werden nach 30 Minuten als fehlgeschlagen abgeschlossen', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    const ins = (id: string, started: string) =>
      srv.ctx.db.run(`INSERT INTO agent_commands (id, machine_id, action, payload_json, status, created_at, started_at) VALUES (?, ?, 'agent.update', '{}', 'running', ?, ?)`, id, machineId, started, started);
    ins('stuck', old);
    ins('active', fresh);
    sweepExpiredCommands(srv.ctx.db);
    expect(srv.ctx.db.get<{ status: string; error: string }>('SELECT status, error FROM agent_commands WHERE id = ?', 'stuck')).toMatchObject({ status: 'failed' });
    expect(srv.ctx.db.get<{ status: string }>('SELECT status FROM agent_commands WHERE id = ?', 'active')?.status).toBe('running');
  });

  it('warnt, wenn ein „erfolgreiches“ Update nicht ankommt (Agent läuft noch mit alter Version)', async () => {
    const finished = new Date(Date.now() - 10 * 60_000).toISOString();
    srv.ctx.db.run(`UPDATE machines SET agent_version = '0.4.0' WHERE id = ?`, machineId);
    srv.ctx.db.run(
      `INSERT INTO agent_commands (id, machine_id, action, payload_json, status, created_at, finished_at, result_json)
       VALUES ('u1', ?, 'agent.update', '{}', 'done', ?, ?, ?)`,
      machineId, finished, finished, JSON.stringify({ restarting: true, new_version: '0.7.0' }),
    );
    expect((await machine()).update_warning).toContain('0.7.0');
    srv.ctx.db.run(`UPDATE machines SET agent_version = '0.7.0' WHERE id = ?`, machineId);
    expect((await machine()).update_warning).toBeNull();
    // frisches Update: Agent hat noch Zeit zum Neustart
    srv.ctx.db.run(`UPDATE machines SET agent_version = '0.4.0' WHERE id = ?`, machineId);
    srv.ctx.db.run(`UPDATE agent_commands SET finished_at = ? WHERE id = 'u1'`, new Date().toISOString());
    expect((await machine()).update_warning).toBeNull();
  });
});
