import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { buildProjectContext } from '../src/services/contextBuilder.js';

describe('Phase E: Decisions, Changelog, Known Issues, History', () => {
  let srv: TestServer;
  let cookie: string;
  let base: string;
  let projectId: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const project = await srv.request('POST', '/api/projects', { cookie, body: { name: 'WebApp' } });
    projectId = project.body.data.id;
    base = `/api/projects/${projectId}`;
  });
  afterEach(async () => {
    await srv.close();
  });

  it('Decisions: anlegen, entscheiden, validieren', async () => {
    const created = await srv.request('POST', `${base}/decisions`, {
      cookie,
      body: { title: 'SQLite statt Postgres', rationale: 'einfach' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('proposed');
    expect(created.body.data.decided_at).toBeNull();

    const accepted = await srv.request('PATCH', `${base}/decisions/${created.body.data.id}`, {
      cookie,
      body: { status: 'accepted' },
    });
    expect(accepted.body.data.status).toBe('accepted');
    expect(accepted.body.data.decided_at).toBeTruthy();
    expect(accepted.body.data.title).toBe('SQLite statt Postgres');

    const bad = await srv.request('PATCH', `${base}/decisions/${created.body.data.id}`, {
      cookie,
      body: { status: 'nope' },
    });
    expect(bad.status).toBe(400);
    expect((await srv.request('POST', `${base}/decisions`, { cookie, body: {} })).status).toBe(400);
  });

  it('Changelog und Known Issues: Lebenszyklus', async () => {
    const entry = await srv.request('POST', `${base}/changelog`, {
      cookie,
      body: { version: '1.1.0', summary: 'Backups' },
    });
    expect(entry.status).toBe(201);
    expect(entry.body.data.source).toBe('manual');

    const issue = await srv.request('POST', `${base}/known-issues`, {
      cookie,
      body: { title: 'Flaky Test', severity: 'high' },
    });
    expect(issue.body.data.status).toBe('open');
    const resolved = await srv.request('PATCH', `${base}/known-issues/${issue.body.data.id}`, {
      cookie,
      body: { status: 'resolved' },
    });
    expect(resolved.body.data.resolved_at).toBeTruthy();
    const reopened = await srv.request('PATCH', `${base}/known-issues/${issue.body.data.id}`, {
      cookie,
      body: { status: 'open' },
    });
    expect(reopened.body.data.resolved_at).toBeNull();
    expect(
      (await srv.request('POST', `${base}/known-issues`, { cookie, body: { title: 'x', severity: 'z' } })).status,
    ).toBe(400);
  });

  it('History fasst alle Quellen zusammen, Context enthält Decisions und Issues', async () => {
    await srv.request('POST', `${base}/changelog`, { cookie, body: { summary: 'Release' } });
    const d = await srv.request('POST', `${base}/decisions`, {
      cookie,
      body: { title: 'Vanilla JS', status: 'accepted' },
    });
    expect(d.status).toBe(201);
    await srv.request('POST', `${base}/known-issues`, { cookie, body: { title: 'Bug A' } });
    await srv.request('POST', `${base}/tasks`, { cookie, body: { title: 'Task A' } });

    const history = await srv.request('GET', `${base}/history`, { cookie });
    const types = history.body.data.map((e: { type: string }) => e.type).sort();
    expect(types).toEqual(['changelog', 'decision', 'known_issue', 'task']);

    const ctxFiles = buildProjectContext({ db: srv.ctx.db, projectId });
    expect(ctxFiles['CONTEXT.md']).toContain('Vanilla JS');
    expect(ctxFiles['CURRENT_STATE.md']).toContain('Bug A');
    expect(ctxFiles['CHANGELOG_RECENT.md']).toContain('Release');
  });

  it('Rollen: Viewer darf lesen, aber nicht schreiben', async () => {
    const viewerRes = await srv.request('POST', '/api/users', {
      cookie,
      body: { email: 'v@devdeck.test', password: 'viewer-pass-123', display_name: 'V', system_role: 'developer' },
    });
    expect(viewerRes.status).toBe(201);
    expect(viewerRes.status).toBe(201);
    await srv.request('POST', `${base}/members`, {
      cookie,
      body: { email: 'v@devdeck.test', role: 'viewer' },
    });
    const vc = await srv.login('v@devdeck.test', 'viewer-pass-123');
    expect((await srv.request('GET', `${base}/decisions`, { cookie: vc })).status).toBe(200);
    expect((await srv.request('POST', `${base}/changelog`, { cookie: vc, body: { summary: 'x' } })).status).toBe(403);
  });
});
