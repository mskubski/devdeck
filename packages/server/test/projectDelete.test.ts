import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { runBackupScheduleTick } from '../src/services/projectBackups.js';

describe('Projekt löschen (nur Projekt / mit Daten)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let secretId: string;

  const countOf = (table: string, id = projectId): number => srv.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, id)!.n;
  const del = (body: Record<string, unknown>, c = cookie, id = projectId) => srv.request('DELETE', `/api/projects/${id}`, { cookie: c, body });

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'Alpha' } })).body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/tasks`, { cookie, body: { title: 'Aufgabe 1' } });
    secretId = (await srv.request('POST', `/api/projects/${projectId}/secrets`, { cookie, body: { name: 'KEY', kind: 'env', environment: 'development' } })).body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, { cookie, body: { value: 'geheim' } });
    const m = await srv.enroll(cookie, 'pc');
    machineId = m.machineId;
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', agent_version='0.17.0', platform='linux', workspace_root='/data' WHERE id=?`, machineId);
    await srv.request('POST', `/api/projects/${projectId}/workspaces`, { cookie, body: { machine_id: machineId, local_path: '/data/alpha' } });
    await srv.request('POST', `/api/projects/${projectId}/backup-jobs`, {
      cookie, body: { name: 'Job', machine_id: machineId, target_dir: '/backups/alpha', sources: [{ id: 'd', kind: 'sqlite', label: 'DB', config: { path: '/data/alpha/a.db' } }], schedule: { mode: 'interval', every_hours: 1 } },
    });
  });
  afterEach(async () => {
    await srv.close();
  });

  it('zeigt vor dem Löschen, was am Projekt hängt', async () => {
    const r = await srv.request('GET', `/api/projects/${projectId}/delete-preview`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.data.name).toBe('Alpha');
    expect(r.body.data.counts).toMatchObject({ tasks: 1, secrets: 1, workspaces: 1, backup_jobs: 1, members: 1 });
  });

  it('„nur Projekt“: verschwindet aus Listen und ruht, Daten bleiben, Name wird frei, Admin kann wiederherstellen', async () => {
    expect((await del({ mode: 'keep' })).status).toBe(428); // Bestätigung fehlt
    expect((await del({ mode: 'komisch', confirm: true })).status).toBe(400);
    expect((await del({ mode: 'keep', confirm: true })).status).toBe(200);

    expect((await srv.request('GET', '/api/projects', { cookie })).body.data.map((p: any) => p.name)).not.toContain('Alpha');
    expect((await srv.request('GET', `/api/projects/${projectId}`, { cookie })).status).toBe(404);
    expect((await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).status).toBe(404);
    expect((await srv.request('GET', '/api/auth/me', { cookie })).body.data.memberships.map((m: any) => m.name)).not.toContain('Alpha');
    const gone = (await srv.request('GET', '/api/projects?deleted=1', { cookie })).body.data;
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ id: projectId, deleted_name: 'Alpha' });

    // Daten bleiben
    expect(countOf('tasks')).toBe(1);
    expect(countOf('secrets')).toBe(1);
    expect(countOf('workspaces')).toBe(1);
    expect(countOf('backup_jobs')).toBe(1);

    // ruht: geplante Backups starten nicht mehr, der Name ist wieder frei
    const jobBefore = srv.ctx.db.get<{ id: string }>('SELECT id FROM backup_jobs WHERE project_id = ?', projectId)!;
    srv.ctx.db.run(`UPDATE backup_jobs SET last_triggered_at = '2020-01-01T00:00:00Z' WHERE id = ?`, jobBefore.id);
    expect(runBackupScheduleTick(srv.ctx)).toEqual([]);
    const again = await srv.request('POST', '/api/projects', { cookie, body: { name: 'Alpha' } });
    expect(again.status).toBe(201);

    // Wiederherstellen: Name ist inzwischen vergeben → Zusatz; danach ist alles wieder da
    const restored = await srv.request('POST', `/api/projects/${projectId}/restore`, { cookie });
    expect(restored.status).toBe(200);
    expect(restored.body.data.name).toBe('Alpha (wiederhergestellt)');
    expect((await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data).toHaveLength(1);
    expect((await srv.request('GET', '/api/projects?deleted=1', { cookie })).body.data).toHaveLength(0);
  });

  it('„mit Daten“: nur nach exakter Eingabe des Projektnamens, löscht alles in DevDeck inkl. Secret-Werte im Vault, Audit bleibt', async () => {
    const ref = srv.ctx.db.get<{ vault_reference: string }>('SELECT vault_reference FROM secrets WHERE id = ?', secretId)!.vault_reference;
    expect((await del({ mode: 'purge' })).status).toBe(428);
    expect((await del({ mode: 'purge', confirm_name: 'alpha' })).status).toBe(428); // Schreibweise zählt
    expect(countOf('tasks')).toBe(1);

    const res = await del({ mode: 'purge', confirm_name: 'Alpha' });
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toMatchObject({ tasks: 1, secrets: 1, workspaces: 1, backup_jobs: 1 });
    expect(srv.ctx.db.get('SELECT 1 AS x FROM projects WHERE id = ?', projectId)).toBeUndefined();
    for (const t of ['tasks', 'secrets', 'workspaces', 'backup_jobs', 'project_members']) expect(countOf(t)).toBe(0);
    expect(() => srv.ctx.vault!.get(ref)).toThrow(/nicht gefunden/); // der verschlüsselte Wert ist aus dem Vault entfernt
    const audit = srv.ctx.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE project_id = ? AND action = 'project.purge'`, projectId);
    expect(audit).toHaveLength(1);
  });

  it('nur Owner/Admin dürfen löschen; ein gelöschtes Projekt lässt sich nur von Admins endgültig löschen (mit Namen)', async () => {
    await srv.request('POST', '/api/users', { cookie, body: { email: 'dev@devdeck.test', password: 'dev-pass-123', system_role: 'developer' } });
    const dev = await srv.login('dev@devdeck.test', 'dev-pass-123');
    await srv.request('POST', `/api/projects/${projectId}/members`, { cookie, body: { email: 'dev@devdeck.test', role: 'maintainer' } });
    expect((await del({ mode: 'keep', confirm: true }, dev)).status).toBe(403);
    expect((await srv.request('GET', `/api/projects/${projectId}/delete-preview`, { cookie: dev })).status).toBe(403);

    await del({ mode: 'keep', confirm: true });
    expect((await srv.request('GET', '/api/projects?deleted=1', { cookie: dev })).status).toBe(403);
    expect((await srv.request('POST', `/api/projects/${projectId}/restore`, { cookie: dev })).status).toBe(403);
    const wrong = await srv.request('DELETE', `/api/projects/${projectId}/permanent`, { cookie, body: { confirm_name: 'Alpha (gelöscht)' } });
    expect(wrong.status).toBe(428);
    const ok = await srv.request('DELETE', `/api/projects/${projectId}/permanent`, { cookie, body: { confirm_name: 'Alpha' } });
    expect(ok.status).toBe(200);
    expect(srv.ctx.db.get('SELECT 1 AS x FROM projects WHERE id = ?', projectId)).toBeUndefined();
    expect(countOf('tasks')).toBe(0);
  });

  it('ein gelöschtes Projekt wird vom Agenten nicht mehr bedient (keine Workspaces, keine Sessions)', async () => {
    const token = (await srv.enroll(cookie, 'zweiter-pc')).token;
    const wsId = srv.ctx.db.get<{ id: string }>('SELECT id FROM workspaces WHERE project_id = ?', projectId)!.id;
    srv.ctx.db.run('UPDATE workspaces SET machine_id = (SELECT id FROM machines WHERE name = ?) WHERE id = ?', 'zweiter-pc', wsId);
    expect((await srv.request('GET', '/api/agent/workspaces', { token })).body.data).toHaveLength(1);
    await del({ mode: 'keep', confirm: true });
    expect((await srv.request('GET', '/api/agent/workspaces', { token })).body.data).toHaveLength(0);
  });
});
