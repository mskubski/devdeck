import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isKnownIssueIssue, knownFromRemote, MAX_CREATE_PER_RUN, remoteFromKnown, remoteFromTask, taskFromRemote, type RemoteIssue,
} from '../src/services/issueSync.js';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

interface FakeIssue {
  number: number; title: string; body: string | null; state: 'open' | 'closed'; state_reason: string | null;
  labels: Array<{ name: string }>; created_at: string; updated_at: string; pull_request?: object;
}

/** Minimales GitHub: Issues im Speicher, Zeitstempel zählen hoch (damit `since` wie bei GitHub filtert). */
class FakeGitHub {
  issues: FakeIssue[] = [];
  calls: string[] = [];
  private clock = Date.now();
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  add(p: Partial<FakeIssue> & { title: string }): FakeIssue {
    const t = this.tick();
    const issue: FakeIssue = {
      number: this.issues.length + 1, body: null, state: 'open', state_reason: null, labels: [], created_at: t, updated_at: t, ...p,
    } as FakeIssue;
    this.issues.push(issue);
    return issue;
  }
  edit(n: number, p: Partial<FakeIssue>): void {
    Object.assign(this.issues.find((i) => i.number === n)!, p, { updated_at: this.tick() });
  }
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const m = /^\/repos\/acme\/app\/issues(?:\/(\d+))?$/.exec(url.pathname);
    if (!m) return json(404, {});
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!m[1] && method === 'GET') {
      const since = url.searchParams.get('since');
      const list = this.issues.filter((i) => !since || i.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return json(200, list);
    }
    if (!m[1] && method === 'POST') {
      const i = this.add({ title: body.title, body: body.body ?? null, labels: (body.labels ?? []).map((name: string) => ({ name })) });
      return json(201, i);
    }
    const issue = this.issues.find((i) => i.number === Number(m[1]));
    if (!issue) return json(404, {});
    if (method === 'GET') return json(200, issue);
    if (method === 'PATCH') {
      const next: Partial<FakeIssue> = {};
      if (body.title !== undefined) next.title = body.title;
      if (body.body !== undefined) next.body = body.body;
      if (body.state !== undefined) { next.state = body.state; next.state_reason = body.state === 'closed' ? body.state_reason ?? 'completed' : null; }
      if (body.labels !== undefined) next.labels = body.labels.map((name: string) => ({ name }));
      this.edit(issue.number, next);
      return json(200, issue);
    }
    return json(405, {});
  }) as typeof fetch;
}

const remote = (over: Partial<RemoteIssue>): RemoteIssue => ({
  number: 1, title: 'T', body: null, state: 'open', state_reason: null, labels: [], created_at: '', updated_at: '', ...over,
});

describe('GitHub-Issue-Abgleich: Zuordnung (rein)', () => {
  it('Issue → Task: Status, Priorität, in Arbeit', () => {
    expect(taskFromRemote(remote({ labels: ['P4', 'in-progress'], body: 'Text\r\n' }), 3)).toEqual({ title: 'T', body: 'Text', status: 'in_progress', priority: 4 });
    expect(taskFromRemote(remote({ state: 'closed', state_reason: 'completed' }), 3).status).toBe('done');
    expect(taskFromRemote(remote({ state: 'closed', state_reason: 'not_planned' }), 3).status).toBe('cancelled');
    expect(taskFromRemote(remote({}), 2).priority).toBe(2); // ohne Label bleibt die bisherige Priorität
  });

  it('Issue → Known Issue: bug/known-issue-Label, Schwere, Status', () => {
    expect(isKnownIssueIssue(['Bug'])).toBe(true);
    expect(isKnownIssueIssue(['enhancement'])).toBe(false);
    expect(knownFromRemote(remote({ labels: ['bug', 'severity-high'], state: 'closed' }))).toMatchObject({ severity: 'high', status: 'resolved' });
    expect(knownFromRemote(remote({ labels: ['bug'] })).severity).toBe('medium');
  });

  it('DevDeck → GitHub: verwaltete Labels ersetzen, fremde behalten', () => {
    const t = remoteFromTask({ title: 'A', body: 'b', status: 'in_progress', priority: 5 }, ['enhancement', 'P1', 'in-progress']);
    expect(t).toMatchObject({ state: 'open', labels: ['enhancement', 'P5', 'in-progress'] });
    expect(remoteFromTask({ title: 'A', body: '', status: 'cancelled', priority: 3 }, [])).toMatchObject({ state: 'closed', state_reason: 'not_planned', labels: ['P3'] });
    expect(remoteFromKnown({ title: 'K', body: '', status: 'resolved', severity: 'low' }, ['bug', 'severity-high'])).toMatchObject({
      state: 'closed', state_reason: 'completed', labels: ['bug', 'known-issue', 'severity-low'],
    });
  });
});

describe('GitHub-Issue-Abgleich (Server, Fake-GitHub)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let connectorId: string;
  let gh: FakeGitHub;

  beforeEach(async () => {
    srv = await startTestServer();
    gh = new FakeGitHub();
    srv.ctx.fetch = gh.fetch;
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'WebApp' } })).body.data.id;
    const secretId = (await srv.request('POST', `/api/projects/${projectId}/secrets`, { cookie, body: { name: 'GITHUB_TOKEN', kind: 'env', environment: 'production' } })).body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, { cookie, body: { value: 'ghp_x' } });
    connectorId = (await srv.request('POST', `/api/projects/${projectId}/connectors`, { cookie, body: { type: 'github', name: 'Repo', secret_id: secretId, config: { repo: 'acme/app' } } })).body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  const sync = async () => (await srv.request('POST', `/api/projects/${projectId}/connectors/${connectorId}/sync/run`, { cookie })).body.data;
  const tasks = async () => (await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data;
  const known = async () => (await srv.request('GET', `/api/projects/${projectId}/known-issues`, { cookie })).body.data;
  const newTask = (title: string, extra: Record<string, unknown> = {}) => srv.request('POST', `/api/projects/${projectId}/tasks`, { cookie, body: { title, ...extra } });

  it('übernimmt GitHub-Issues als Tasks und Known Issues (ohne Pull Requests)', async () => {
    gh.add({ title: 'Login-Seite bauen', body: 'Details', labels: [{ name: 'P4' }] });
    gh.add({ title: 'Absturz beim Speichern', labels: [{ name: 'bug' }, { name: 'severity-high' }] });
    gh.add({ title: 'Ein PR', pull_request: {} });
    gh.add({ title: 'Erledigtes', state: 'closed', state_reason: 'completed' });
    const r = await sync();
    expect(r).toMatchObject({ ok: true, created_local: 3, created_remote: 0, conflicts: 0 });
    const t = await tasks();
    expect(t.map((x: { title: string }) => x.title).sort()).toEqual(['Erledigtes', 'Login-Seite bauen']);
    expect(t.find((x: { title: string }) => x.title === 'Login-Seite bauen')).toMatchObject({ priority: 4, description: 'Details', status: 'open', github_issue: { number: 1, url: 'https://github.com/acme/app/issues/1' } });
    expect(t.find((x: { title: string }) => x.title === 'Erledigtes').status).toBe('done');
    expect((await known())[0]).toMatchObject({ title: 'Absturz beim Speichern', severity: 'high', status: 'open', github_issue: { number: 2 } });
    // zweiter Lauf: nichts mehr zu tun
    expect(await sync()).toMatchObject({ ok: true, created_local: 0, updated_local: 0, created_remote: 0, updated_remote: 0, message: 'Alles abgeglichen – keine Änderungen' });
  });

  it('legt für lokale Tasks und Known Issues GitHub-Issues mit Labels an', async () => {
    await newTask('Deploy automatisieren', { priority: 5, description: 'Per Knopf' });
    const done = (await newTask('Alt', { priority: 2 })).body.data;
    await srv.request('POST', `/api/projects/${projectId}/tasks/${done.id}/complete`, { cookie });
    await srv.request('POST', `/api/projects/${projectId}/known-issues`, { cookie, body: { title: 'Cache hängt', severity: 'low' } });
    const r = await sync();
    expect(r).toMatchObject({ ok: true, created_remote: 3 });
    const byTitle = (t: string) => gh.issues.find((i) => i.title === t)!;
    expect(byTitle('Deploy automatisieren')).toMatchObject({ body: 'Per Knopf', state: 'open' });
    expect(byTitle('Deploy automatisieren').labels.map((l) => l.name)).toEqual(['P5']);
    expect(byTitle('Alt')).toMatchObject({ state: 'closed', state_reason: 'completed' });
    expect(byTitle('Cache hängt').labels.map((l) => l.name)).toEqual(['known-issue', 'severity-low']);
    expect((await tasks()).every((x: { github_issue: unknown }) => x.github_issue)).toBe(true);
    expect(await sync()).toMatchObject({ created_remote: 0, updated_remote: 0 });
  });

  it('gibt Änderungen in beide Richtungen weiter', async () => {
    const t = (await newTask('Aufgabe', { priority: 3 })).body.data;
    await sync(); // Issue #1 angelegt
    // lokal: in Arbeit setzen → GitHub bekommt Label in-progress
    await srv.request('PATCH', `/api/projects/${projectId}/tasks/${t.id}`, { cookie, body: { status: 'in_progress' } });
    expect(await sync()).toMatchObject({ updated_remote: 1, created_remote: 0 });
    expect(gh.issues[0]!.labels.map((l) => l.name)).toEqual(['P3', 'in-progress']);
    // GitHub: schließen (nicht geplant) und Titel ändern → lokal übernommen
    gh.edit(1, { title: 'Aufgabe (neu)', state: 'closed', state_reason: 'not_planned' });
    expect(await sync()).toMatchObject({ updated_local: 1, updated_remote: 0 });
    expect((await tasks())[0]).toMatchObject({ title: 'Aufgabe (neu)', status: 'cancelled' });
    // Known Issue lokal lösen → GitHub schließt
    const k = (await srv.request('POST', `/api/projects/${projectId}/known-issues`, { cookie, body: { title: 'Fehler' } })).body.data;
    await sync();
    await srv.request('PATCH', `/api/projects/${projectId}/known-issues/${k.id}`, { cookie, body: { status: 'resolved' } });
    await sync();
    expect(gh.issues.find((i) => i.title === 'Fehler')).toMatchObject({ state: 'closed' });
  });

  it('behält fremde Labels und löst Konflikte zugunsten von GitHub', async () => {
    const t = (await newTask('Konflikt', { priority: 3 })).body.data;
    await sync();
    gh.edit(1, { labels: [{ name: 'P3' }, { name: 'enhancement' }] });
    await sync();
    // beide Seiten ändern den Titel
    await srv.request('PATCH', `/api/projects/${projectId}/tasks/${t.id}`, { cookie, body: { status: 'in_progress' } });
    gh.edit(1, { state: 'closed', state_reason: 'completed' });
    const r = await sync();
    expect(r.conflicts).toBe(1);
    expect((await tasks())[0].status).toBe('done'); // GitHub gewinnt
    // lokale Änderung an einem Issue mit fremdem Label lässt das Label stehen
    await srv.request('PATCH', `/api/projects/${projectId}/tasks/${t.id}`, { cookie, body: { status: 'open' } });
    await sync();
    expect(gh.issues[0]!.labels.map((l) => l.name)).toEqual(['enhancement', 'P3']);
    expect(gh.issues[0]!.state).toBe('open');
  });

  it('begrenzt neue Issues je Lauf und holt den Rest nach', async () => {
    for (let i = 0; i < MAX_CREATE_PER_RUN + 3; i += 1) await newTask(`Task ${i}`);
    const first = await sync();
    expect(first).toMatchObject({ created_remote: MAX_CREATE_PER_RUN, pending: 3 });
    const second = await sync();
    expect(second).toMatchObject({ created_remote: 3, pending: 0 });
    expect(gh.issues).toHaveLength(MAX_CREATE_PER_RUN + 3);
  });

  it('meldet Fehler verständlich und löst Verknüpfungen gelöschter Issues', async () => {
    await newTask('Wird gelöscht');
    await sync();
    gh.issues = []; // Issue auf GitHub verschwunden
    await srv.request('PATCH', `/api/projects/${projectId}/tasks/${(await tasks())[0].id}`, { cookie, body: { status: 'in_progress' } });
    const r = await sync();
    expect(r.errors[0]).toContain('nicht mehr vorhanden');
    expect((await tasks())[0].github_issue).toBeNull();
    expect(gh.issues).toEqual([]); // nicht erneut angelegt
    expect((await sync()).errors).toEqual([]); // und nicht bei jedem Lauf gemeldet
    srv.ctx.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const bad = await sync();
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toContain('Token ungültig');
  });

  it('Aktivieren verlangt Bestätigung, zeigt Vorschau und stößt den Abgleich an', async () => {
    await newTask('A');
    await newTask('B');
    await srv.request('POST', `/api/projects/${projectId}/known-issues`, { cookie, body: { title: 'K' } });
    const base = `/api/projects/${projectId}/connectors/${connectorId}/sync`;
    expect((await srv.request('GET', `${base}/preview`, { cookie })).body.data).toEqual({ unlinked_tasks: 2, unlinked_known_issues: 1, linked: 0 });
    expect((await srv.request('PUT', base, { cookie, body: { enabled: true } })).status).toBe(428);
    const on = await srv.request('PUT', base, { cookie, body: { enabled: true, confirm: true } });
    expect(on.status).toBe(200);
    expect(on.body.data.sync_enabled).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // erster Lauf im Hintergrund
    expect(gh.issues).toHaveLength(3);
    const off = await srv.request('PUT', base, { cookie, body: { enabled: false } });
    expect(off.body.data.sync_enabled).toBe(false);
    expect(srv.ctx.db.get(`SELECT 1 FROM audit_log WHERE action = 'connector.sync.enable'`)).toBeTruthy();
  });

  it('lokale Änderungen stoßen den Abgleich nur bei aktiviertem Abgleich an', async () => {
    const { scheduleIssueSync } = await import('../src/services/issueSync.js');
    scheduleIssueSync(srv.ctx, projectId, 10);
    await newTask('Ohne Abgleich');
    await new Promise((r) => setTimeout(r, 100));
    expect(gh.calls).toEqual([]); // deaktiviert → nichts passiert
    srv.ctx.db.run('UPDATE project_connectors SET sync_enabled = 1 WHERE id = ?', connectorId);
    scheduleIssueSync(srv.ctx, projectId, 10);
    await new Promise((r) => setTimeout(r, 300));
    expect(gh.issues.map((i) => i.title)).toEqual(['Ohne Abgleich']);
  });
});
