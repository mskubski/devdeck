import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Coding Sessions & Handover (Phase F)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const project = await srv.request('POST', '/api/projects', { cookie, body: { name: 'WebApp' } });
    projectId = project.body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  it('startet eine Session und erstellt einen strukturierten Handover', async () => {
    const session = await srv.request('POST', `/api/projects/${projectId}/sessions`, {
      cookie,
      body: { goal: 'Login-Bug beheben' },
    });
    expect(session.status).toBe(201);
    const sessionId = session.body.data.id;

    const payload = {
      completed: ['Bug reproduziert', 'Fix geschrieben'],
      open_items: ['Tests ergänzen'],
      changed_files: ['src/auth.ts'],
      notes: 'Root cause war ein Timing-Problem.',
    };
    const handover = await srv.request(
      'POST',
      `/api/projects/${projectId}/sessions/${sessionId}/handover`,
      { cookie, body: { payload: JSON.stringify(payload) } },
    );
    expect(handover.status).toBe(201);
    expect(handover.body.data.payload).toEqual(payload);

    const list = await srv.request('GET', `/api/projects/${projectId}/handovers`, { cookie });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].payload.notes).toContain('Timing-Problem');

    const finished = await srv.request(
      'POST',
      `/api/projects/${projectId}/sessions/${sessionId}/complete`,
      { cookie },
    );
    expect(finished.status).toBe(200);
    expect(finished.body.data.status).toBe('closed');
  });
});
