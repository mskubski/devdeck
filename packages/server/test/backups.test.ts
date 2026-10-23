import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { applyRetention, createSystemBackup, runScheduledBackup, verifyBundle } from '../src/services/backups.js';
import { applyBundle } from '../src/restore.js';

describe('Phase I: Backups', () => {
  let srv: TestServer;
  let cookie: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
  });
  afterEach(async () => {
    await srv.close();
  });

  it('erstellt ein verifizierbares Backup ohne Vault-Key', async () => {
    const res = await srv.request('POST', '/api/backups', { cookie });
    expect(res.status).toBe(201);
    const row = res.body.data;
    expect(row.status).toBe('success');
    const files = fs.readdirSync(row.target_path).sort();
    expect(files).toEqual(['backup_manifest.json', 'config.json', 'devdeck.db', 'vault.db']);
    expect(files.some((f) => f.endsWith('.key'))).toBe(false);
    const cfg = fs.readFileSync(path.join(row.target_path, 'config.json'), 'utf8');
    expect(cfg).not.toContain(TEST_ADMIN.password);

    const verify = await srv.request('POST', `/api/backups/${row.id}/verify`, { cookie });
    expect(verify.body.data.ok).toBe(true);
    expect(verify.body.data.backup.verified_at).toBeTruthy();

    const list = await srv.request('GET', '/api/backups', { cookie });
    expect(list.body.data.backups).toHaveLength(1);
  });

  it('erkennt manipulierte Backups', async () => {
    const res = await srv.request('POST', '/api/backups', { cookie });
    fs.appendFileSync(path.join(res.body.data.target_path, 'devdeck.db'), 'x');
    const verify = await srv.request('POST', `/api/backups/${res.body.data.id}/verify`, { cookie });
    expect(verify.body.data.ok).toBe(false);
    expect(verify.body.data.problems[0]).toContain('devdeck.db');
  });

  it('verlangt Admin-Rolle und bietet keinen Restore-Endpunkt', async () => {
    expect((await srv.request('GET', '/api/backups')).status).toBe(401);
    const res = await srv.request('POST', '/api/backups/x/restore', { cookie });
    expect(res.status).toBe(404);
  });

  it('Retention behält pro Tag/Woche das neueste Backup', async () => {
    const mk = async () => createSystemBackup(srv.ctx, { id: null, label: 'test', type: 'system' });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await mk()).id);
    // Zeitstempel künstlich auf vier verschiedene Tage verteilen
    ids.forEach((id, i) =>
      srv.ctx.db.run(
        'UPDATE backups SET created_at = ? WHERE id = ?',
        new Date(Date.now() - i * 86_400_000).toISOString(),
        id,
      ),
    );
    (srv.ctx.config as { backupRetentionDaily: number }).backupRetentionDaily = 2;
    (srv.ctx.config as { backupRetentionWeekly: number }).backupRetentionWeekly = 0;
    const { deleted } = applyRetention(srv.ctx);
    expect(deleted).toHaveLength(2);
    expect(srv.ctx.db.all('SELECT id FROM backups')).toHaveLength(2);
  });

  it('Scheduler erstellt nur nach Ablauf des Intervalls', async () => {
    const first = runScheduledBackup(srv.ctx);
    expect(first?.status).toBe('success');
    expect(runScheduledBackup(srv.ctx)).toBeNull();
    expect(runScheduledBackup(srv.ctx, Date.now() + 25 * 3_600_000)?.status).toBe('success');
    (srv.ctx.config as { backupIntervalHours: number }).backupIntervalHours = 0;
    expect(runScheduledBackup(srv.ctx, Date.now() + 99 * 3_600_000)).toBeNull();
  });

  it('applyBundle stellt DB-Dateien in einen Temp-Ordner wieder her und sichert Altbestand', async () => {
    srv.ctx.db.run(`INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES ('p1','Vorher','vorher','t','t')`);
    const res = await srv.request('POST', '/api/backups', { cookie });
    const bundle = res.body.data.target_path;
    expect(verifyBundle(bundle).ok).toBe(true);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-restore-'));
    fs.mkdirSync(path.join(target, 'vault'));
    fs.writeFileSync(path.join(target, 'devdeck.db'), 'alt');
    const out = applyBundle(bundle, target);
    expect(out.restored).toEqual(['devdeck.db', 'vault.db']);
    expect(fs.readFileSync(path.join(out.safetyCopyDir, 'devdeck.db'), 'utf8')).toBe('alt');
    const restored = new DatabaseSync(path.join(target, 'devdeck.db'), { readOnly: true });
    const row = restored.prepare(`SELECT name FROM projects WHERE id='p1'`).get() as { name: string };
    expect(row.name).toBe('Vorher');
    restored.close();
    fs.rmSync(target, { recursive: true, force: true });
  });
});
