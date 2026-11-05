import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { importProjectData } from '../src/services/projectImport.js';

const CLEAN = '🛠️ Termine per Chat löschen/auflisten: aktuell darf jeder erlaubte Absender';
const BROKEN = '�️ Termine per Chat löschen/auflisten: aktuell darf jeder erlaubte Absender';

describe('Doppelte Tasks (Import-Abgleich und Bereinigung)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let userId: string;

  const insert = (id: string, title: string, status: string, createdAt: string): void => {
    srv.ctx.db.run(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Abschnitt: X', ?, 3, ?, ?, ?)`,
      id, projectId, title, status, userId, createdAt, createdAt,
    );
  };
  const titles = (): string[] => srv.ctx.db.all<{ title: string }>('SELECT title FROM tasks WHERE project_id = ? ORDER BY created_at', projectId).map((t) => t.title);

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    userId = srv.ctx.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  const run = (tasks: Array<{ title: string; done?: boolean }>) =>
    importProjectData(srv.ctx, {
      projectId, userId, actorLabel: 'test', changelog: [], secrets: [], overwrite: false, dryRun: false,
      tasks: tasks.map((t) => ({ title: t.title, done: t.done ?? false, priority: 3, section: 'X' })),
    });

  it('Import legt keinen zweiten Task an, wenn der Titel früher beschädigt gespeichert wurde – und repariert ihn', () => {
    insert('a', BROKEN, 'open', '2026-10-30T09:09:00Z');
    const r = run([{ title: CLEAN }, { title: 'Ganz neu' }]);
    expect(r.tasks).toMatchObject({ total: 2, new: 1, existing: 1, repaired: 1 });
    expect(titles()).toEqual([CLEAN, 'Ganz neu']);
    // erneuter Import: nichts mehr zu tun
    expect(run([{ title: CLEAN }, { title: 'Ganz neu' }]).tasks).toMatchObject({ new: 0, existing: 2, repaired: 0 });
    expect(titles()).toHaveLength(2);
  });

  it('bereinigt bestehende Duplikate: weitester Stand bleibt, Titel wird repariert, mit GitHub-Issue verknüpfte werden verworfen', async () => {
    insert('old', BROKEN, 'open', '2026-10-30T09:09:00Z');
    insert('new', BROKEN, 'open', '2026-11-01T12:32:00Z');
    insert('prog', CLEAN, 'in_progress', '2026-11-02T08:00:00Z');
    insert('x', 'Unabhängiger Task', 'open', '2026-11-02T08:00:00Z');
    insert('y1', 'Verknüpft', 'open', '2026-11-02T09:00:00Z');
    insert('y2', 'Verknüpft', 'open', '2026-11-02T10:00:00Z');
    srv.ctx.db.run(`INSERT INTO project_connectors (id, project_id, type, name, config_json, created_at) VALUES ('c', ?, 'github', 'gh', '{}', '2026-10-01T00:00:00Z')`, projectId);
    srv.ctx.db.run(`INSERT INTO issue_links (project_id, connector_id, kind, local_id, issue_number, synced_hash, last_synced_at) VALUES (?, 'c', 'task', 'y2', 7, 'h', '2026-11-02T10:00:00Z')`, projectId);

    const plan = await srv.request('POST', `/api/projects/${projectId}/tasks/dedupe`, { cookie, body: { dry_run: true } });
    expect(plan.body.data).toMatchObject({ dry_run: true, groups: 2, duplicates: 3 });
    expect(titles()).toHaveLength(6); // Vorschau ändert nichts
    expect((await srv.request('POST', `/api/projects/${projectId}/tasks/dedupe`, { cookie, body: {} })).status).toBe(428);

    const done = await srv.request('POST', `/api/projects/${projectId}/tasks/dedupe`, { cookie, body: { confirm: true } });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ groups: 2, deleted: 2, cancelled: 1 });
    const rows = srv.ctx.db.all<{ id: string; title: string; status: string }>('SELECT id, title, status FROM tasks WHERE project_id = ? ORDER BY id', projectId);
    expect(rows.map((r) => [r.id, r.status])).toEqual([['prog', 'in_progress'], ['x', 'open'], ['y1', 'open'], ['y2', 'cancelled']]);
    expect(rows.find((r) => r.id === 'prog')!.title).toBe(CLEAN);

    const again = await srv.request('POST', `/api/projects/${projectId}/tasks/dedupe`, { cookie, body: { dry_run: true } });
    expect(again.body.data.duplicates).toBe(0); // das verworfene Duplikat (mit Issue) bleibt sichtbar, zählt aber nicht erneut
  });

  it('PATCH ändert den Titel eines Tasks', async () => {
    insert('t', BROKEN, 'open', '2026-10-30T09:09:00Z');
    const r = await srv.request('PATCH', `/api/projects/${projectId}/tasks/t`, { cookie, body: { title: CLEAN } });
    expect(r.status).toBe(200);
    expect(titles()).toEqual([CLEAN]);
  });
});
