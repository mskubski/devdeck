import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { runBackupScheduleTick, sweepStuckBackups } from '../src/services/projectBackups.js';

/**
 * Projekt-Backups. Bewusst KEIN Test, der einen Restore tatsächlich auslöst – geprüft werden nur die Ablehnungen
 * der Sicherheitsschranke (falscher/fehlender Bestätigungstext, falsche Rolle, kein Browser-Login).
 */
describe('Projekt-Backups', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;

  const jobBody = (extra: Record<string, unknown> = {}) => ({
    name: 'Standard',
    machine_id: machineId,
    target_dir: '/backups/app',
    sources: [{ id: 'daten', kind: 'sqlite', label: 'DB', config: { path: '/data/app/app.db' } }],
    schedule: { mode: 'daily', time: '03:00', weekday: 1, every_hours: 24 },
    retention: { keep_days: 30, keep_min: 5 },
    ...extra,
  });
  const createJob = async (extra: Record<string, unknown> = {}) =>
    srv.request('POST', `/api/projects/${projectId}/backup-jobs`, { cookie, body: jobBody(extra) });
  const commands = (action: string) =>
    srv.ctx.db.all<{ id: string; payload_json: string }>(`SELECT id, payload_json FROM agent_commands WHERE action = ?`, action);
  const report = (body: Record<string, unknown>, token = machineToken) =>
    srv.request('POST', '/api/agent/backups/report', { token, body });

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    const m = await srv.enroll(cookie, 'backup-pc');
    machineId = m.machineId;
    machineToken = m.token;
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', agent_version='0.16.0', platform='linux', workspace_root='/data' WHERE id=?`, machineId);
  });
  afterEach(async () => {
    await srv.close();
  });

  it('legt einen Job an, prüft Eingaben und stößt das Einlesen vorhandener Backups an', async () => {
    const res = await createJob();
    expect(res.status).toBe(201);
    expect(res.body.data.target_dir).toBe('/backups/app');
    expect(res.body.data.next_run_at).toBeTruthy();
    expect(commands('backup.scan')).toHaveLength(1);

    expect((await createJob()).status).toBe(409); // Name doppelt
    expect((await createJob({ name: 'x', target_dir: 'relativ/pfad' })).status).toBe(400);
    expect((await createJob({ name: 'x', target_dir: '/' })).status).toBe(400);
    expect((await createJob({ name: 'x', sources: [] })).status).toBe(400);
    expect((await createJob({ name: 'x', schedule: { mode: 'daily', time: '25:00' } })).status).toBe(400);
    expect((await createJob({ name: 'x', sources: [{ id: 'a', kind: 'files', label: 'A', config: { path: '/x' } }, { id: 'a', kind: 'files', label: 'B', config: { path: '/y' } }] })).status).toBe(400);

    const list = await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie });
    expect(list.body.data).toHaveLength(1);
  });

  it('übernimmt vorhandene Backups aus dem Scan und entfernt solche, die nicht mehr existieren', async () => {
    const job = (await createJob()).body.data;
    const bundle = (name: string, created: string) => ({ name, created_at: created, size_bytes: 1000, format: 'legacy', summary: { rows: 5 } });
    const r1 = await report({ job_id: job.id, kind: 'scan', bundles: [bundle('2026-10-01_030000', '2026-10-01T01:00:00Z'), bundle('2026-10-02_030000', '2026-10-02T01:00:00Z')] });
    expect(r1.status).toBe(200);
    let dto = (await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie })).body.data[0];
    expect(dto.backups.map((b: any) => b.origin)).toEqual(['discovered', 'discovered']);
    expect(dto.stats.count).toBe(2);

    await report({ job_id: job.id, kind: 'scan', bundles: [bundle('2026-10-02_030000', '2026-10-02T01:00:00Z')] });
    dto = (await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie })).body.data[0];
    expect(dto.backups).toHaveLength(1);
  });

  it('Lauf: Auftrag an den Agenten, Fortschritt, Ergebnis und Aufbewahrung', async () => {
    const job = (await createJob()).body.data;
    await report({ job_id: job.id, kind: 'scan', bundles: [{ name: '2026-01-01_030000', created_at: '2026-01-01T02:00:00Z', size_bytes: 1, format: 'legacy', summary: {} }] });

    const run = await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${job.id}/run`, { cookie });
    expect(run.status).toBe(202);
    const cmd = commands('backup.run');
    expect(cmd).toHaveLength(1);
    const payload = JSON.parse(cmd[0]!.payload_json);
    expect(payload.target_dir).toBe('/backups/app');
    expect(payload.run_id).toBe(run.body.data.run_id);
    expect(JSON.stringify(payload)).not.toMatch(/secret|password|token/i);

    // parallel nicht möglich
    expect((await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${job.id}/run`, { cookie })).status).toBe(409);

    await report({ job_id: job.id, kind: 'run', run_id: payload.run_id, status: 'running', progress: 'Tabelle x: 5 Zeilen' });
    let dto = (await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie })).body.data[0];
    expect(dto.busy).toBe(true);
    expect(dto.backups[0].progress).toBe('Tabelle x: 5 Zeilen');

    await report({
      job_id: job.id, kind: 'run', run_id: payload.run_id, status: 'success',
      bundles: [{ name: '2026-11-05_030000', created_at: '2026-11-05T02:00:00Z', size_bytes: 4096, format: 'devdeck', summary: { rows: 7 } }],
      deleted: ['2026-01-01_030000'],
    });
    dto = (await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie })).body.data[0];
    expect(dto.busy).toBe(false);
    expect(dto.backups).toHaveLength(1);
    expect(dto.backups[0]).toMatchObject({ status: 'success', bundle_name: '2026-11-05_030000', size_bytes: 4096, trigger: 'manual' });
  });

  it('fehlgeschlagener Lauf wird mit Fehlertext festgehalten; hängende Läufe werden aufgeräumt', async () => {
    const job = (await createJob()).body.data;
    const run = (await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${job.id}/run`, { cookie })).body.data.run_id;
    await report({ job_id: job.id, kind: 'run', run_id: run, status: 'failed', error: 'Quelle DB: Datei fehlt' });
    const dto = (await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie })).body.data[0];
    expect(dto.backups[0]).toMatchObject({ status: 'failed', error: 'Quelle DB: Datei fehlt' });

    const run2 = (await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${job.id}/run`, { cookie })).body.data.run_id;
    expect(sweepStuckBackups(srv.ctx, Date.now() + 5 * 60_000)).toBe(0);
    expect(sweepStuckBackups(srv.ctx, Date.now() + 25 * 60_000)).toBe(1);
    expect(srv.ctx.db.get<{ status: string }>('SELECT status FROM project_backups WHERE id = ?', run2)?.status).toBe('failed');
  });

  it('Zeitplan startet fällige Jobs genau einmal, ruht bei „aus“ und wartet auf offline-Maschinen', async () => {
    const job = (await createJob({ schedule: { mode: 'interval', time: '03:00', weekday: 1, every_hours: 6 } })).body.data;
    const later = new Date(Date.now() + 7 * 3_600_000);
    expect(runBackupScheduleTick(srv.ctx, new Date(Date.now() + 3_600_000))).toEqual([]);
    srv.ctx.db.run(`UPDATE machines SET agent_status='offline' WHERE id=?`, machineId);
    expect(runBackupScheduleTick(srv.ctx, later)).toEqual([]); // offline: später nachholen
    srv.ctx.db.run(`UPDATE machines SET agent_status='online' WHERE id=?`, machineId);
    expect(runBackupScheduleTick(srv.ctx, later)).toEqual([job.id]);
    expect(commands('backup.run')).toHaveLength(1);
    srv.ctx.db.run('UPDATE project_backups SET updated_at = ?', later.toISOString()); // Lebenszeichen zur simulierten Zeit
    expect(runBackupScheduleTick(srv.ctx, later)).toEqual([]); // läuft bereits

    await srv.request('PATCH', `/api/projects/${projectId}/backup-jobs/${job.id}`, { cookie, body: { schedule: { mode: 'off' } } });
    srv.ctx.db.run(`UPDATE project_backups SET status='success', bundle_name='x' || rowid`);
    expect(runBackupScheduleTick(srv.ctx, new Date(Date.now() + 99 * 3_600_000))).toEqual([]);
  });

  it('Backup-Log zeigt Fehler, auch nicht gestartete geplante Backups (ohne Wiederholung bei jedem Tick)', async () => {
    const job = (await createJob({ schedule: { mode: 'interval', time: '03:00', weekday: 1, every_hours: 1 } })).body.data;
    const run = (await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${job.id}/run`, { cookie })).body.data.run_id;
    await report({ job_id: job.id, kind: 'run', run_id: run, status: 'failed', error: 'Secret SUPABASE_SERVICE_ROLE_KEY fehlt' });
    srv.ctx.db.run(`UPDATE machines SET agent_status='offline' WHERE id=?`, machineId);
    const later = new Date(Date.now() + 2 * 3_600_000);
    runBackupScheduleTick(srv.ctx, later);
    runBackupScheduleTick(srv.ctx, later);
    const log = (await srv.request('GET', `/api/projects/${projectId}/backup-log`, { cookie })).body.data as Array<{ level: string; message: string; title: string }>;
    expect(log.filter((e) => e.level === 'error').map((e) => e.message).sort()).toEqual([
      'Geplantes Backup nicht gestartet: Maschine „backup-pc“ ist nicht online',
      'Secret SUPABASE_SERVICE_ROLE_KEY fehlt',
    ]);
  });

  it('lehnt Läufe ab, wenn der Agent die Backup-Funktionen nicht kennt', async () => {
    const job = (await createJob()).body.data;
    srv.ctx.db.run(`UPDATE machines SET agent_version='0.15.0' WHERE id=?`, machineId);
    const res = await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${job.id}/run`, { cookie });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toContain('aktualisieren');
  });

  it('Meldungen und Secrets nur für den Agenten der Job-Maschine', async () => {
    const job = (await createJob()).body.data;
    const other = await srv.enroll(cookie, 'fremd');
    expect((await report({ job_id: job.id, kind: 'scan', bundles: [] }, other.token)).status).toBe(403);
    const sec = await srv.request('POST', `/api/agent/backup-jobs/${job.id}/secrets`, { token: other.token, body: { names: [] } });
    expect(sec.status).toBe(404);
    const own = await srv.request('POST', `/api/agent/backup-jobs/${job.id}/secrets`, { token: machineToken, body: { names: [{ name: 'X', environment: 'production' }] } });
    expect(own.status).toBe(200);
    expect(own.body.data.secrets).toEqual({});
  });

  it('erkennt Supabase- und Postgres-Quellen anhand der Vault-Secrets (ohne Werte zu lesen)', async () => {
    const now = new Date().toISOString();
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'SENTRY_DSN']) {
      srv.ctx.db.run(
        `INSERT INTO secrets (id, project_id, name, kind, environment, vault_reference, version, created_at, updated_at) VALUES (?, ?, ?, 'env', 'production', ?, 1, ?, ?)`,
        `s-${name}`, projectId, name, `ref-${name}`, now, now,
      );
    }
    srv.ctx.db.run(`UPDATE machines SET agent_status='offline' WHERE id=?`, machineId); // kein Agent-Scan nötig
    const res = await srv.request('POST', `/api/projects/${projectId}/backup-jobs/detect`, { cookie, body: { machine_id: machineId } });
    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(res.body.data.candidates.map((c: any) => [c.kind, c]));
    expect(byKind.supabase).toMatchObject({ suggested: true, available: true, config: { url_secret: 'NEXT_PUBLIC_SUPABASE_URL', key_secret: 'SUPABASE_SERVICE_ROLE_KEY', environment: 'production' } });
    expect(byKind.postgres.suggested).toBe(false); // Supabase deckt die Datenbank bereits ab
    expect(res.body.data.notes.join(' ')).toContain('offline');
  });

  describe('Restore-Schranke (nur Ablehnungen)', () => {
    let jobId: string;
    let backupId: string;
    const restoreUrl = () => `/api/projects/${projectId}/backup-jobs/${jobId}/backups/${backupId}/restore`;

    beforeEach(async () => {
      jobId = (await createJob()).body.data.id;
      await report({ job_id: jobId, kind: 'scan', bundles: [{ name: '2026-10-01_030000', created_at: '2026-10-01T01:00:00Z', size_bytes: 1, format: 'legacy', summary: {} }] });
      backupId = srv.ctx.db.get<{ id: string }>('SELECT id FROM project_backups WHERE job_id = ?', jobId)!.id;
    });

    it('verlangt den exakten Bestätigungstext', async () => {
      for (const confirm_text of [undefined, '', 'restore starten', 'RESTORE', 'Restore starten ']) {
        const res = await srv.request('POST', restoreUrl(), { cookie, body: { confirm_text } });
        expect(res.status).toBe(428);
      }
      expect((await srv.request('POST', restoreUrl(), { cookie, body: { confirm: true } })).status).toBe(428);
      expect(commands('backup.restore')).toHaveLength(0);
      expect(srv.ctx.db.all('SELECT 1 FROM backup_restores')).toHaveLength(0);
    });

    it('lässt keinen Restore ohne Browser-Sitzung zu (Bearer-Token genügt nicht)', async () => {
      const token = cookie.split('=')[1]!;
      const res = await srv.request('POST', restoreUrl(), { token, body: { confirm_text: 'Restore starten' } });
      expect(res.status).toBe(403);
      expect(commands('backup.restore')).toHaveLength(0);
    });

    it('verlangt die Projektrolle Owner (Maintainer dürfen sichern, aber nicht wiederherstellen)', async () => {
      const u = await srv.request('POST', '/api/users', { cookie, body: { email: 'dev@devdeck.test', password: 'dev-pass-12345', system_role: 'developer' } });
      expect(u.status).toBe(201);
      const dev = await srv.login('dev@devdeck.test', 'dev-pass-12345');
      // ohne Mitgliedschaft: gar kein Zugriff
      expect((await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie: dev })).status).toBe(403);
      const add = await srv.request('POST', `/api/projects/${projectId}/members`, { cookie, body: { email: 'dev@devdeck.test', role: 'maintainer' } });
      expect(add.status).toBeLessThan(300);
      // als Maintainer: Liste und Lauf ja …
      expect((await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie: dev })).status).toBe(200);
      expect((await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${jobId}/run`, { cookie: dev })).status).toBe(202);
      // … Restore nein, auch mit korrektem Text
      const res = await srv.request('POST', restoreUrl(), { cookie: dev, body: { confirm_text: 'Restore starten' } });
      expect(res.status).toBe(403);
      expect(commands('backup.restore')).toHaveLength(0);
    });

    it('bietet keinen Restore über andere Wege an', async () => {
      expect((await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${jobId}/restore`, { cookie, body: { confirm_text: 'Restore starten' } })).status).toBe(404);
    });
  });
});
