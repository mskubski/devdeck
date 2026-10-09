import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Phase E: Tasks', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const project = await srv.request('POST', '/api/projects', {
      cookie,
      body: { name: 'WebApp' },
    });
    projectId = project.body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  it('legt eine Aufgabe an und listet sie', async () => {
    const created = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'Fehler suchen', description: 'test', priority: 3 },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.title).toBe('Fehler suchen');
    expect(created.body.data.status).toBe('open');
    expect(created.body.data.priority).toBe(3);

    const list = await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].title).toBe('Fehler suchen');
  });

  it('validiert Fehlendes title', async () => {
    const res = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: '' },
    });
    expect(res.status).toBe(400);
  });

  it('validiert ungültige priority', async () => {
    const res = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'x', priority: 6 },
    });
    expect(res.status).toBe(400);
  });

  it('akzeptiert nur bestimmte Status', async () => {
    const created = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'x', status: 'open' as unknown as string },
    });
    expect(created.status).toBe(201);

    const bad = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'y', status: 'unknown' as unknown as string },
    });
    expect(bad.status).toBe(400);
  });

  it('erlaubt maintainer, PATCH und DELETE', async () => {
    const created = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'Task 1' },
    });
    const taskId = created.body.data.id;

    const updated = await srv.request('PATCH', `/api/projects/${projectId}/tasks/${taskId}`, {
      cookie,
      body: { status: 'in_progress' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('in_progress');

    const done = await srv.request('POST', `/api/projects/${projectId}/tasks/${taskId}/complete`, {
      cookie,
    });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('done');
  });

  it('erlaubt maintainer, Aufgabe zu canceln', async () => {
    const created = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie,
      body: { title: 'Zu streichen' },
    });
    const taskId = created.body.data.id;
    const del = await srv.request('DELETE', `/api/projects/${projectId}/tasks/${taskId}`, {
      cookie,
    });
    expect(del.status).toBe(200);
    expect(del.body.data.cancelled).toBe(true);

    const list = await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie });
    expect(list.body.data[0].status).toBe('cancelled');
  });

  it('erlaubt viewer nur Lesezugriff', async () => {
    const viewer = await srv.request('POST', '/api/users', {
      cookie,
      body: { email: 'viewer2@devdeck.test', password: 'vpass123' },
    });
    const viewerCookie = await srv.login('viewer2@devdeck.test', 'vpass123');
    await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie,
      body: { email: 'viewer2@devdeck.test', role: 'viewer' },
    });
    const list = await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie: viewerCookie });
    expect(list.status).toBe(200);

    const create = await srv.request('POST', `/api/projects/${projectId}/tasks`, {
      cookie: viewerCookie,
      body: { title: 'nope' },
    });
    expect(create.status).toBe(403);
  });
});
