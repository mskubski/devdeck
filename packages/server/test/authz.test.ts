import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Authorization: Systemrollen und Projektberechtigungen', () => {
  let srv: TestServer;
  let adminCookie: string;

  beforeEach(async () => {
    srv = await startTestServer();
    adminCookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    await srv.request('POST', '/api/users', {
      cookie: adminCookie,
      body: { email: 'dev@devdeck.test', password: 'dev-pass-123', system_role: 'developer' },
    });
    await srv.request('POST', '/api/users', {
      cookie: adminCookie,
      body: { email: 'outsider@devdeck.test', password: 'out-pass-123' },
    });
  });
  afterEach(async () => {
    await srv.close();
  });

  async function createProject(): Promise<string> {
    const res = await srv.request('POST', '/api/projects', {
      cookie: adminCookie,
      body: { name: 'WebApp', repo_remote: 'https://example.com/webapp.git' },
    });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  it('lässt nur Admins Projekte anlegen', async () => {
    const devCookie = await srv.login('dev@devdeck.test', 'dev-pass-123');
    const res = await srv.request('POST', '/api/projects', {
      cookie: devCookie,
      body: { name: 'NichtErlaubt' },
    });
    expect(res.status).toBe(403);
    expect(await createProject()).toBeTruthy();
  });

  it('verweigert Nicht-Mitgliedern den Projektzugriff (403)', async () => {
    const projectId = await createProject();
    const outsider = await srv.login('outsider@devdeck.test', 'out-pass-123');
    const res = await srv.request('GET', `/api/projects/${projectId}`, { cookie: outsider });
    expect(res.status).toBe(403);
  });

  it('listet Projekte nur für Mitglieder (Admin sieht alle)', async () => {
    const projectId = await createProject();
    const devCookie = await srv.login('dev@devdeck.test', 'dev-pass-123');
    const devList = await srv.request('GET', '/api/projects', { cookie: devCookie });
    expect(devList.status).toBe(200);
    expect(devList.body.data).toHaveLength(0);

    const adminList = await srv.request('GET', '/api/projects', { cookie: adminCookie });
    expect(adminList.body.data.map((p: any) => p.id)).toContain(projectId);
  });

  it('verwaltet Memberships und rolliert Rechte korrekt', async () => {
    const projectId = await createProject();
    const add = await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { email: 'dev@devdeck.test', role: 'viewer' },
    });
    expect(add.status).toBe(201);

    const devCookie = await srv.login('dev@devdeck.test', 'dev-pass-123');
    const read = await srv.request('GET', `/api/projects/${projectId}`, { cookie: devCookie });
    expect(read.status).toBe(200);
    expect(read.body.data.role).toBe('viewer');

    const manage = await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: devCookie,
      body: { email: 'outsider@devdeck.test', role: 'developer' },
    });
    expect(manage.status).toBe(403);

    srv.ctx.db.run(
      `UPDATE project_members SET role = 'maintainer' WHERE project_id = ? AND user_id =
       (SELECT id FROM users WHERE email = 'dev@devdeck.test')`,
      projectId,
    );
    const allowed = await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: devCookie,
      body: { email: 'outsider@devdeck.test', role: 'developer' },
    });
    expect(allowed.status).toBe(201);
  });

  it('verbietet Entfernen des letzten Owners', async () => {
    const projectId = await createProject();
    const adminId = (
      await srv.request('GET', '/api/auth/me', { cookie: adminCookie })
    ).body.data.user.id;
    const res = await srv.request('DELETE', `/api/projects/${projectId}/members/${adminId}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('verhindert Duplikate bei Memberships', async () => {
    const projectId = await createProject();
    const first = await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { email: 'dev@devdeck.test', role: 'developer' },
    });
    expect(first.status).toBe(201);
    const second = await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { email: 'dev@devdeck.test', role: 'developer' },
    });
    expect(second.status).toBe(409);
  });

  it('schützt den letzten aktiven Admin vor Sperrung', async () => {
    const me = (await srv.request('GET', '/api/auth/me', { cookie: adminCookie })).body.data;
    const res = await srv.request('PATCH', `/api/users/${me.user.id}`, {
      cookie: adminCookie,
      body: { disabled: true },
    });
    expect(res.status).toBe(409);
  });

  it('verlangt für Benutzerverwaltung die Systemrolle admin', async () => {
    const devCookie = await srv.login('dev@devdeck.test', 'dev-pass-123');
    const res = await srv.request('GET', '/api/users', { cookie: devCookie });
    expect(res.status).toBe(403);
  });

  it('protokolliert Membership-Änderungen im Audit', async () => {
    const projectId = await createProject();
    await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { email: 'dev@devdeck.test', role: 'viewer' },
    });
    const entries = srv.ctx.db.all<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'project.membership.add'`,
    );
    expect(entries.length).toBe(1);
  });

  it('erzwingt Anmeldung für alle geschützten API-Routen', async () => {
    const paths: Array<[string, string]> = [
      ['GET', '/api/projects'],
      ['GET', '/api/users'],
      ['GET', '/api/audit'],
      ['POST', '/api/projects'],
    ];
    for (const [method, path] of paths) {
      const res = await srv.request(method, path, { body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
