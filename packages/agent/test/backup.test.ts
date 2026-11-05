import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import type { ServerClient } from '../src/client.js';
import { scanBundles, verifyBundleDir } from '../src/backup/bundle.js';
import { applyRetentionTo, createBackup, Reporter } from '../src/backup/run.js';
import { backupSupabase } from '../src/backup/supabase.js';
import { safeJoin } from '../src/backup/fsutil.js';

/** Hier wird ausschließlich gesichert und geprüft – es gibt keinen Test, der etwas wiederherstellt. */

let root: string;
let workspace: string;
let target: string;
const reports: Array<Record<string, unknown>> = [];
const client = {
  request: async (_m: string, _p: string, o: { body?: Record<string, unknown> } = {}) => {
    if (o.body) reports.push(o.body);
    return { status: 200, data: { secrets: {} } };
  },
} as unknown as ServerClient;
const config = { workspaceRoot: '' } as AgentConfig;
const retention = { keep_days: 30, keep_min: 2 };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-backup-'));
  workspace = path.join(root, 'ws');
  target = path.join(root, 'backups');
  fs.mkdirSync(path.join(workspace, 'uploads', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'uploads', 'a.txt'), 'hallo');
  fs.writeFileSync(path.join(workspace, 'uploads', 'sub', 'b.txt'), 'welt');
  fs.writeFileSync(path.join(workspace, 'uploads', '.env'), 'GEHEIM=1');
  config.workspaceRoot = root;
  reports.length = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const reporter = () => new Reporter(client, { job_id: 'j1', kind: 'run', run_id: 'r1' });
const options = (sources: any[]) => ({ client, config, jobId: 'j1', runId: 'r1', targetDir: target, sources, retention, trigger: 'manual' });

describe('Backup: Ordner und SQLite sichern', () => {
  it('erstellt ein prüfbares Backup ohne Zugangsdaten-Dateien und erkennt Manipulation', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dbFile = path.join(workspace, 'app.db');
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('eins'), ('zwei');");
    db.close();

    const { bundle } = await createBackup(
      options([
        { id: 'db', kind: 'sqlite', label: 'DB', enabled: true, config: { path: dbFile } },
        { id: 'uploads', kind: 'files', label: 'Uploads', enabled: true, config: { path: path.join(workspace, 'uploads'), exclude: [] } },
      ]),
      reporter(),
    );
    expect(bundle.format).toBe('devdeck');
    expect(bundle.summary.sources).toHaveLength(2);
    const dir = path.join(target, bundle.name);
    expect(fs.readdirSync(dir).sort()).toEqual(['backup_manifest.json', 'files', 'sqlite']);
    expect(fs.readdirSync(target).filter((n) => n.startsWith('.'))).toEqual([]); // kein Rest vom Zwischenordner

    // Die gesicherte SQLite-Datei enthält die Daten
    const copy = new DatabaseSync(path.join(dir, 'sqlite', 'db.sqlite'), { readOnly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(2);
    copy.close();

    expect((await verifyBundleDir(dir)).ok).toBe(true);
    fs.appendFileSync(path.join(dir, 'sqlite', 'db.sqlite'), 'x');
    const bad = await verifyBundleDir(dir);
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toContain('sqlite/db.sqlite');
  });

  it('nimmt .env-Dateien nicht ins Archiv auf', async () => {
    const { bundle } = await createBackup(options([{ id: 'uploads', kind: 'files', label: 'U', enabled: true, config: { path: path.join(workspace, 'uploads') } }]), reporter());
    const { execFileSync } = await import('node:child_process');
    const listing = execFileSync('tar', ['-tzf', path.join(target, bundle.name, 'files', 'uploads.tar.gz')], { encoding: 'utf8' });
    expect(listing).toContain('uploads/a.txt');
    expect(listing).toContain('uploads/sub/b.txt');
    expect(listing).not.toContain('.env');
  });

  it('lehnt Backup-Ordner innerhalb der Quelle und Quellen außerhalb des Workspace-Roots ab und hinterlässt nichts', async () => {
    const inside = { id: 'u', kind: 'files', label: 'U', enabled: true, config: { path: path.join(workspace, 'uploads') } };
    await expect(createBackup({ ...options([inside]), targetDir: path.join(workspace, 'uploads', 'bk') }, reporter())).rejects.toThrow(/innerhalb der Quelle/);
    const outside = { id: 'o', kind: 'files', label: 'O', enabled: true, config: { path: os.tmpdir() } };
    await expect(createBackup(options([outside]), reporter())).rejects.toThrow(/außerhalb/);
    await expect(createBackup({ ...options([inside]), targetDir: 'relativ' }, reporter())).rejects.toThrow(/absolut/);
  });

  it('räumt bei einer fehlgeschlagenen Quelle auf und lässt frühere Backups unangetastet', async () => {
    const ok = { id: 'u', kind: 'files', label: 'U', enabled: true, config: { path: path.join(workspace, 'uploads') } };
    const first = await createBackup(options([ok]), reporter());
    await new Promise((r) => setTimeout(r, 1100)); // anderer Sekunden-Zeitstempel
    const broken = { id: 'x', kind: 'sqlite', label: 'Weg', enabled: true, config: { path: path.join(workspace, 'fehlt.db') } };
    await expect(createBackup(options([ok, broken]), reporter())).rejects.toThrow(/existiert nicht/);
    // Fehler erst mitten im Lauf (Datei ist keine SQLite-Datenbank): Zwischenordner muss verschwinden
    fs.writeFileSync(path.join(workspace, 'kaputt.db'), 'das ist keine datenbank, nur text '.repeat(10));
    const corrupt = { id: 'k', kind: 'sqlite', label: 'Kaputt', enabled: true, config: { path: path.join(workspace, 'kaputt.db') } };
    await expect(createBackup(options([ok, corrupt]), reporter())).rejects.toThrow();
    expect(scanBundles(target).map((b) => b.name)).toEqual([first.bundle.name]);
    expect(fs.readdirSync(target).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });
});

describe('Backup: vorhandene Backups erkennen und aufbewahren', () => {
  const legacy = (name: string, tables = ['reviews', 'toilets']) => {
    const dir = path.join(target, name);
    fs.mkdirSync(path.join(dir, 'database'), { recursive: true });
    for (const t of tables) fs.writeFileSync(path.join(dir, 'database', `${t}.json`), '[\n  {"id": 1}\n]');
    fs.writeFileSync(path.join(dir, 'backup_manifest.json'), JSON.stringify({ timestamp: '2026-01-01T01:00:00+00:00', db_rows: 2, storage_files: 0, tables_exported: tables, backup_type: 'full' }));
    return dir;
  };

  it('erkennt Backups des bisherigen PeeFinder-Skripts samt Inhalt und ignoriert fremde Ordner', async () => {
    legacy('2026-10-01_030001');
    legacy('2026-10-02_030002');
    fs.mkdirSync(path.join(target, 'irgendwas'));
    fs.mkdirSync(path.join(target, '2026-10-03_030000')); // ohne Manifest = unvollständig → nie anfassen
    const found = scanBundles(target);
    expect(found.map((b) => b.name)).toEqual(['2026-10-02_030002', '2026-10-01_030001']);
    expect(found[0]).toMatchObject({ format: 'legacy', summary: { rows: 2, tables: 2 } });
    expect((await verifyBundleDir(path.join(target, found[0]!.name))).ok).toBe(true);
    fs.writeFileSync(path.join(target, '2026-10-02_030002', 'database', 'reviews.json'), '[\n  {"id": 1'); // abgeschnitten
    expect((await verifyBundleDir(path.join(target, '2026-10-02_030002'))).problems).toEqual(['Tabelle unvollständig: reviews']);
  });

  it('Aufbewahrung löscht nur alte, echte Backup-Ordner – nie fremde Dateien', () => {
    for (const n of ['2026-01-01_030000', '2026-01-02_030000', '2026-01-03_030000', '2026-11-04_030000']) legacy(n);
    fs.mkdirSync(path.join(target, 'notizen'));
    fs.mkdirSync(path.join(target, '2026-01-04_030000')); // ohne Manifest
    const deleted = applyRetentionTo(target, { keep_days: 30, keep_min: 2 }, new Date(2026, 10, 5));
    expect(deleted.sort()).toEqual(['2026-01-01_030000', '2026-01-02_030000']);
    expect(fs.readdirSync(target).sort()).toEqual(['2026-01-03_030000', '2026-01-04_030000', '2026-11-04_030000', 'notizen']);
  });

  it('safeJoin verhindert Ausbrüche aus dem Zielordner', () => {
    expect(() => safeJoin(target, '../etc/passwd')).toThrow();
    expect(() => safeJoin(target, 'a/../../x')).toThrow();
    expect(safeJoin(target, 'a/b.txt')).toBe(path.join(path.resolve(target), 'a', 'b.txt'));
  });
});

describe('Backup: Supabase (gegen einen lokalen Testserver)', () => {
  let server: http.Server;
  let url: string;
  const calls: string[] = [];
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `n${i + 1}` })); // genau eine volle Seite

  beforeEach(async () => {
    calls.length = 0;
    server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== 'Bearer testkey') return json(401, { message: 'no' });
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/rest/v1/') {
        return json(200, { definitions: { toilets: { required: ['id'], properties: { id: { type: 'integer', format: 'bigint', description: 'Note:\nThis is a Primary Key.<pk/>' }, name: { type: 'string' } } }, leer: { properties: { id: { type: 'integer' } } } } });
      }
      if (u.pathname === '/rest/v1/toilets') {
        const [from] = String(req.headers.range ?? '0-999').split('-').map(Number);
        if (from! >= rows.length) return json(416, { message: 'Requested range not satisfiable' });
        return json(206, rows.slice(from, from! + 1000));
      }
      if (u.pathname === '/rest/v1/leer') return json(200, []);
      if (u.pathname === '/storage/v1/bucket') return json(200, [{ name: 'bilder' }]);
      if (u.pathname === '/storage/v1/object/list/bilder') {
        const body: string[] = [];
        req.on('data', (c) => body.push(c));
        req.on('end', () => {
          const { prefix, offset } = JSON.parse(body.join('')) as { prefix: string; offset: number };
          if (offset > 0) return json(200, []);
          if (prefix === '') return json(200, [{ name: 'user1', id: null }, { name: 'top.jpg', id: 'a' }]);
          if (prefix === 'user1/') return json(200, [{ name: 'x.jpg', id: 'b' }]);
          return json(200, []);
        });
        return;
      }
      if (u.pathname.startsWith('/storage/v1/object/bilder/')) {
        res.writeHead(200);
        return res.end(`daten:${decodeURIComponent(u.pathname)}`);
      }
      return json(404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('sichert Tabellen (Seitengrenze exakt 1000), Schema und Storage im Format des bisherigen Skripts', async () => {
    const bundleDir = path.join(root, 'bundle');
    fs.mkdirSync(bundleDir);
    const result = await backupSupabase({ access: { url, key: 'testkey' }, bundleDir, targetDir: target, buckets: [], schema: true, progress: () => undefined });
    expect(result).toMatchObject({ rows: 1000, storage_files: 2, tables: ['toilets', 'leer'], storage_buckets: ['bilder'] });
    const exported = JSON.parse(fs.readFileSync(path.join(bundleDir, 'database', 'toilets.json'), 'utf8')) as Array<{ id: number }>;
    expect(exported).toHaveLength(1000);
    expect(exported[999]!.id).toBe(1000);
    expect(JSON.parse(fs.readFileSync(path.join(bundleDir, 'database', 'leer.json'), 'utf8'))).toEqual([]);
    expect(fs.readFileSync(path.join(bundleDir, 'storage', 'bilder', 'user1', 'x.jpg'), 'utf8')).toBe('daten:/storage/v1/object/bilder/user1/x.jpg');
    expect(fs.readFileSync(path.join(bundleDir, 'schema', 'tables_schema.sql'), 'utf8')).toContain('PRIMARY KEY ("id")');
    expect(calls.some((c) => c.includes('order=id.asc'))).toBe(true);
  });

  it('meldet einen abgelehnten Schlüssel verständlich und einen fehlenden Bucket als Fehler', async () => {
    const bundleDir = path.join(root, 'bundle2');
    fs.mkdirSync(bundleDir);
    await expect(backupSupabase({ access: { url, key: 'falsch' }, bundleDir, targetDir: target, buckets: [], schema: false, progress: () => undefined })).rejects.toThrow(/Schlüssel abgelehnt/);
    await expect(backupSupabase({ access: { url, key: 'testkey' }, bundleDir, targetDir: target, buckets: ['gibt-es-nicht'], schema: false, progress: () => undefined })).rejects.toThrow(/Bucket nicht gefunden/);
  });
});
