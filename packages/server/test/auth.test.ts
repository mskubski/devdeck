import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Authentication', () => {
  let srv: TestServer;

  beforeEach(async () => {
    srv = await startTestServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('erlaubt Login mit korrekten Zugangsdaten und liefert Session-Cookie', async () => {
    const res = await srv.request('POST', '/api/auth/login', {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(TEST_ADMIN.email);
    expect(res.body.data.system_role).toBe('admin');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('dd_session='))).toBe(true);
    expect(cookies.find((c) => c.startsWith('dd_session='))).toContain('HttpOnly');
  });

  it('lehnt falsches Passwort ab (401) und protokolliert den Fehlversuch', async () => {
    const res = await srv.request('POST', '/api/auth/login', {
      body: { email: TEST_ADMIN.email, password: 'falsch-123' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error!.code).toBe('UNAUTHORIZED');
    const audit = srv.ctx.db.all<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE action = 'auth.login'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.result).toBe('failure');
  });

  it('lehnt unbekannte E-Mail ohne Hinweis auf Ursache ab', async () => {
    const res = await srv.request('POST', '/api/auth/login', {
      body: { email: 'unbekannt@example.com', password: 'irgendwas-123' },
    });
    expect(res.status).toBe(401);
  });

  it('verlangt für /me eine Anmeldung', async () => {
    const res = await srv.request('GET', '/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('liefert /me mit gültigem Session-Cookie inkl. Memberships', async () => {
    const cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const res = await srv.request('GET', '/api/auth/me', { cookie });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(TEST_ADMIN.email);
    expect(Array.isArray(res.body.data.memberships)).toBe(true);
  });

  it('sperrt gesperrte Benutzer auch mit korrektem Passwort', async () => {
    const cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    // Zweiten User anlegen und sperren
    const created = await srv.request(
      'POST',
      '/api/users',
      { cookie, body: { email: 'temp@devdeck.test', password: 'temp-pass-123' } },
    );
    expect(created.status).toBe(201);
    const userId = created.body.data.id;
    const patched = await srv.request('PATCH', `/api/users/${userId}`, {
      cookie,
      body: { disabled: true },
    });
    expect(patched.status).toBe(200);

    const res = await srv.request('POST', '/api/auth/login', {
      body: { email: 'temp@devdeck.test', password: 'temp-pass-123' },
    });
    expect(res.status).toBe(401);
  });

  it('macht Session nach Logout ungültig', async () => {
    const cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const before = await srv.request('GET', '/api/auth/me', { cookie });
    expect(before.status).toBe(200);

    const out = await srv.request('POST', '/api/auth/logout', { cookie });
    expect(out.status).toBe(200);

    const after = await srv.request('GET', '/api/auth/me', { cookie });
    expect(after.status).toBe(401);
  });

  it('akzeptiert Bearer-Token der CLI nach Login (für token-basierte Nutzung)', async () => {
    const res = await srv.request('POST', '/api/auth/login', {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('dd_session='))!;
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const me = await srv.request('GET', '/api/auth/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(TEST_ADMIN.email);
  });

  it('lehnst ungültige JSON-Bodies sauber ab', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ kaputt',
    });
    expect(res.status).toBe(400);
  });
});
