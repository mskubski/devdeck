import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Workspaces: Pfadprüfung, Bearbeiten, Entfernen, Provision-Fallback', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let winMachine: string;
  let linMachine: string;

  const register = (machine: string, localPath: string) =>
    srv.request('POST', `/api/projects/${projectId}/workspaces`, { cookie, body: { machine_id: machine, local_path: localPath } });

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    srv.ctx.db.run('UPDATE projects SET repo_remote = ?, default_branch = ? WHERE id = ?', 'https://github.com/x/app', 'main', projectId);
    winMachine = (await srv.enroll(cookie, 'win')).machineId;
    linMachine = (await srv.enroll(cookie, 'lin')).machineId;
    srv.ctx.db.run(`UPDATE machines SET platform='win32', workspace_root='D:\\DEVDECK\\DEV', agent_version='0.4.0', agent_status='online' WHERE id=?`, winMachine);
    srv.ctx.db.run(`UPDATE machines SET platform='linux', workspace_root='/home/u/Development', agent_version='0.4.0', agent_status='online' WHERE id=?`, linMachine);
  });
  afterEach(async () => {
    await srv.close();
  });

  it('prüft beim Registrieren, ob der Pfad unterhalb des Workspace-Roots der Maschine liegt (Windows und Linux)', async () => {
    expect((await register(winMachine, 'D:\\DEVDECK\\DEV\\helferle')).status).toBe(201);
    expect((await register(winMachine, 'd:\\devdeck\\dev\\andere')).status).toBe(201); // Windows: Groß-/Kleinschreibung egal
    const outside = await register(winMachine, 'D:\\helferle');
    expect(outside.status).toBe(400);
    expect(outside.body.error?.message).toContain('D:\\DEVDECK\\DEV');
    expect((await register(winMachine, 'D:\\DEVDECK\\DEV\\..\\x')).status).toBe(400);
    expect((await register(winMachine, 'helferle')).status).toBe(400); // relativ

    expect((await register(linMachine, '/home/u/Development/app')).status).toBe(201);
    expect((await register(linMachine, '/home/u/other')).status).toBe(400);
    expect((await register(linMachine, '/home/u/Development-evil/x')).status).toBe(400);
  });

  it('gleicher Pfad auf verschiedenen Maschinen ist erlaubt, doppelt auf derselben nicht', async () => {
    srv.ctx.db.run(`UPDATE machines SET platform='linux', workspace_root='/data' WHERE id IN (?, ?)`, winMachine, linMachine);
    expect((await register(winMachine, '/data/app')).status).toBe(201);
    expect((await register(linMachine, '/data/app')).status).toBe(201);
    expect((await register(linMachine, '/data/app')).status).toBe(409);
  });

  it('Bearbeiten: Pfad korrigieren (mit Prüfung, Konflikt-Schutz und Audit)', async () => {
    srv.ctx.db.run(`UPDATE machines SET workspace_root=NULL WHERE id=?`, winMachine);
    const created = await register(winMachine, 'D:\\helferle'); // Root unbekannt → erlaubt (Altbestand)
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    srv.ctx.db.run(`UPDATE machines SET workspace_root='D:\\DEVDECK\\DEV' WHERE id=?`, winMachine);

    const bad = await srv.request('PATCH', `/api/workspaces/${id}`, { cookie, body: { local_path: 'D:\\nochmal-falsch' } });
    expect(bad.status).toBe(400);
    const ok = await srv.request('PATCH', `/api/workspaces/${id}`, { cookie, body: { local_path: 'D:\\DEVDECK\\DEV\\helferle', branch: 'main' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ local_path: 'D:\\DEVDECK\\DEV\\helferle', branch: 'main' });

    await register(winMachine, 'D:\\DEVDECK\\DEV\\zweiter');
    const clash = await srv.request('PATCH', `/api/workspaces/${id}`, { cookie, body: { local_path: 'D:\\DEVDECK\\DEV\\zweiter' } });
    expect(clash.status).toBe(409);
    const audits = srv.ctx.db.all<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE action = 'workspace.update'`);
    expect(JSON.parse(audits[0]!.detail_json)).toMatchObject({ from_path: 'D:\\helferle', local_path: 'D:\\DEVDECK\\DEV\\helferle' });
  });

  it('Entfernen: braucht confirm, verwirft wartende Aufträge, blockiert bei laufendem Auftrag', async () => {
    const id = (await register(linMachine, '/home/u/Development/app')).body.data.id;
    expect((await srv.request('DELETE', `/api/workspaces/${id}`, { cookie, body: {} })).status).toBe(428);

    const sync = await srv.request('POST', `/api/workspaces/${id}/sync`, { cookie });
    srv.ctx.db.run(`UPDATE agent_commands SET status='running' WHERE id=?`, sync.body.data.command_id);
    expect((await srv.request('DELETE', `/api/workspaces/${id}`, { cookie, body: { confirm: true } })).status).toBe(409);
    srv.ctx.db.run(`UPDATE agent_commands SET status='queued' WHERE id=?`, sync.body.data.command_id);

    const res = await srv.request('DELETE', `/api/workspaces/${id}`, { cookie, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(srv.ctx.db.get('SELECT 1 FROM workspaces WHERE id=?', id)).toBeUndefined();
    expect(srv.ctx.db.get<{ status: string }>('SELECT status FROM agent_commands WHERE id=?', sync.body.data.command_id)?.status).toBe('expired');
    expect((await srv.request('DELETE', `/api/workspaces/${id}`, { cookie, body: { confirm: true } })).status).toBe(404);
  });

  it('Provision nutzt ohne eigene Angabe Repository und Standard-Branch des Projekts', async () => {
    const id = (await register(linMachine, '/home/u/Development/app')).body.data.id;
    const res = await srv.request('POST', `/api/workspaces/${id}/provision`, { cookie, body: { confirm: true } });
    expect(res.status).toBe(202);
    const payload = JSON.parse(srv.ctx.db.get<{ payload_json: string }>('SELECT payload_json FROM agent_commands WHERE id=?', res.body.data.command_id)!.payload_json);
    expect(payload).toMatchObject({ repo_remote: 'https://github.com/x/app', branch: 'main', workspace_id: id });
  });
});
