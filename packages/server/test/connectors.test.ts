import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Phase J: Konnektoren (GitHub)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let secretId: string;
  let calls: Array<{ url: string; auth: string | null }>;
  let mode: 'ok' | 'unauthorized' | 'norepo';

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('Authorization');
    calls.push({ url, auth });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (mode === 'unauthorized') return json(401, {});
    if (url.endsWith('/user')) return json(200, { login: 'octocat' });
    if (url.includes('/search/issues')) return json(200, { total_count: 2 });
    if (mode === 'norepo') return json(404, {});
    return json(200, {
      full_name: 'acme/app', private: true, default_branch: 'main',
      open_issues_count: 5, pushed_at: '2026-10-01T00:00:00Z', archived: false,
    });
  }) as typeof fetch;

  beforeEach(async () => {
    srv = await startTestServer();
    srv.ctx.fetch = fakeFetch;
    calls = [];
    mode = 'ok';
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'WebApp' } })).body.data.id;
    const secret = await srv.request('POST', `/api/projects/${projectId}/secrets`, {
      cookie,
      body: { name: 'GITHUB_TOKEN', kind: 'env', environment: 'production' },
    });
    secretId = secret.body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie,
      body: { value: 'ghp_supersecret' },
    });
  });
  afterEach(async () => {
    await srv.close();
  });

  const create = (body: Record<string, unknown>) =>
    srv.request('POST', `/api/projects/${projectId}/connectors`, { cookie, body });

  it('listet Typen, legt Konnektor an und prüft ihn mit Vault-Credential', async () => {
    const types = await srv.request('GET', '/api/connector-types', { cookie });
    expect(types.body.data.map((t: { type: string }) => t.type)).toEqual(['github']);

    const created = await create({ type: 'github', name: 'Repo', secret_id: secretId, config: { repo: 'acme/app' } });
    expect(created.status).toBe(201);
    expect(created.body.data.config).toEqual({ repo: 'acme/app' });
    expect(JSON.stringify(created.body)).not.toContain('ghp_supersecret');

    const check = await srv.request('POST', `/api/projects/${projectId}/connectors/${created.body.data.id}/check`, { cookie });
    expect(check.status).toBe(200);
    expect(check.body.data.ok).toBe(true);
    expect(check.body.data.details).toMatchObject({ login: 'octocat', open_pull_requests: 2, default_branch: 'main' });
    expect(check.body.data.connector.last_check_ok).toBe(true);
    expect(calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(calls[0]!.auth).toBe('Bearer ghp_supersecret');
    expect(JSON.stringify(check.body)).not.toContain('ghp_supersecret');

    const audits = srv.ctx.db.all<{ detail_json: string | null }>(`SELECT detail_json FROM audit_log WHERE action LIKE 'connector.%'`);
    expect(audits.length).toBe(2);
    for (const a of audits) expect(a.detail_json ?? '').not.toContain('ghp_supersecret');
  });

  it('meldet ungültiges Token und fehlendes Repo als nicht ok', async () => {
    const c = (await create({ type: 'github', name: 'Repo', secret_id: secretId, config: { repo: 'acme/app' } })).body.data;
    mode = 'unauthorized';
    let res = await srv.request('POST', `/api/projects/${projectId}/connectors/${c.id}/check`, { cookie });
    expect(res.body.data).toMatchObject({ ok: false, message: 'Token ungültig oder abgelaufen' });
    mode = 'norepo';
    res = await srv.request('POST', `/api/projects/${projectId}/connectors/${c.id}/check`, { cookie });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.message).toContain('nicht gefunden');
  });

  it('validiert Eingaben', async () => {
    expect((await create({ type: 'unknown', name: 'x', secret_id: secretId })).status).toBe(400);
    expect((await create({ type: 'github', name: 'x', secret_id: secretId, config: { repo: '../etc' } })).status).toBe(400);
    expect((await create({ type: 'github', name: 'x', secret_id: 'nope', config: { repo: 'a/b' } })).status).toBe(404);
    expect((await create({ type: 'github', name: 'Repo', secret_id: secretId, config: { repo: 'a/b' } })).status).toBe(201);
    expect((await create({ type: 'github', name: 'Repo', secret_id: secretId, config: { repo: 'a/b' } })).status).toBe(409);
  });

  it('Check ohne hinterlegten Wert schlägt kontrolliert fehl; Löschen funktioniert', async () => {
    const empty = await srv.request('POST', `/api/projects/${projectId}/secrets`, {
      cookie,
      body: { name: 'EMPTY', kind: 'env', environment: 'production' },
    });
    const c = (await create({ type: 'github', name: 'Leer', secret_id: empty.body.data.id, config: { repo: 'a/b' } })).body.data;
    const res = await srv.request('POST', `/api/projects/${projectId}/connectors/${c.id}/check`, { cookie });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('SECRET_UNAVAILABLE');
    expect((await srv.request('DELETE', `/api/projects/${projectId}/connectors/${c.id}`, { cookie })).status).toBe(200);
    expect((await srv.request('GET', `/api/projects/${projectId}/connectors`, { cookie })).body.data).toHaveLength(0);
  });
});
