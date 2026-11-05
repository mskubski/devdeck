import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerClient } from '../src/client.js';
import type { AgentConfig } from '../src/config.js';
import { exportBundle, importBundle, listReplicaBundles, pruneReplica } from '../src/backup/replica.js';
import { listFiles } from '../src/backup/fsutil.js';
import { startTestServer, TEST_ADMIN, type TestServer } from '../../server/test/helpers.js';
import { getReplica, runReplicaTick } from '../../server/src/services/backupReplicas.js';

const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Backup-Ordner im Format der Agenten: Zeitstempel-Name, Manifest, verschachtelte Dateien, eine leere Datei. */
function makeBundle(dir: string, name: string, seed: string): void {
  const b = path.join(dir, name);
  fs.mkdirSync(path.join(b, 'storage', 'x'), { recursive: true });
  fs.mkdirSync(path.join(b, 'database'), { recursive: true });
  fs.writeFileSync(path.join(b, 'backup_manifest.json'), JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', seed }));
  fs.writeFileSync(path.join(b, 'database', 'a.json'), `[${seed}]`);
  fs.writeFileSync(path.join(b, 'storage', 'x', 'y.txt'), `Inhalt ${seed}`.repeat(1000));
  fs.writeFileSync(path.join(b, 'storage', 'leer.bin'), '');
}

describe('Backup-Replikation (Agent + Server)', () => {
  let tmp: string;
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let jobId: string;
  let src: { id: string; token: string; client: ServerClient };
  let dst: { id: string; token: string; client: ServerClient };
  let srcDir: string;
  let dstDir: string;

  const asAgent = async (name: string): Promise<{ id: string; token: string; client: ServerClient }> => {
    const m = await srv.enroll(cookie, name);
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', agent_version='0.17.0', platform=?, workspace_root=? WHERE id=?`, PLATFORM, tmp, m.machineId);
    const config: AgentConfig = { serverUrl: srv.base, machineId: m.machineId, machineToken: m.token, localToken: 'x', workspaceRoot: tmp, localPort: 0, agentVersion: '0.17.0' };
    return { id: m.machineId, token: m.token, client: new ServerClient(config) };
  };

  /** Simuliert den Agenten: holt die Aufträge der Maschine ab, führt die echten Replikations-Funktionen aus und meldet das Ergebnis. */
  const agentTurn = async (m: { token: string; client: ServerClient }): Promise<void> => {
    const res = await srv.request('GET', '/api/agent/commands?wait=0', { token: m.token });
    if (res.status === 204) return;
    for (const c of res.body.data as Array<{ id: string; action: string; payload: Record<string, any> }>) {
      let body: Record<string, unknown>;
      try {
        let data: unknown;
        if (c.action === 'backup.prune') data = pruneReplica(c.payload.target_dir, c.payload.keep, c.payload.delete === true);
        else if (c.action === 'backup.export') data = await exportBundle(m.client, { replicaId: c.payload.replica_id, targetDir: c.payload.target_dir, bundle: c.payload.bundle });
        else if (c.action === 'backup.import') data = await importBundle(m.client, { replicaId: c.payload.replica_id, targetDir: c.payload.target_dir, bundle: c.payload.bundle });
        else continue;
        body = { status: 'done', data };
      } catch (err) {
        body = { status: 'failed', error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } };
      }
      await srv.request('POST', `/api/agent/commands/${c.id}/result`, { token: m.token, body });
    }
  };

  /** Tick + beide Agenten abwechselnd, bis die Replik fertig ist. */
  const settle = async (scope: 'job' | 'system' = 'job'): Promise<ReturnType<typeof getReplica>> => {
    for (let i = 0; i < 80; i += 1) {
      runReplicaTick(srv.ctx);
      await agentTurn(src);
      await agentTurn(dst);
      runReplicaTick(srv.ctx);
      const row = getReplica(srv.ctx, scope, scope === 'job' ? jobId : null);
      if (row && row.state === 'idle' && row.sync_requested === 0) return row;
    }
    throw new Error(`Replik wurde nicht fertig: ${JSON.stringify(getReplica(srv.ctx, scope, scope === 'job' ? jobId : null))}`);
  };

  const report = (bundles: string[]) =>
    srv.request('POST', '/api/agent/backups/report', {
      token: src.token,
      body: { job_id: jobId, kind: 'scan', bundles: bundles.map((name) => ({ name, created_at: `${name.slice(0, 10)}T01:00:00Z`, size_bytes: 1, format: 'devdeck', summary: {} })) },
    });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-replica-'));
    srcDir = path.join(tmp, 'primary');
    dstDir = path.join(tmp, 'replica');
    fs.mkdirSync(srcDir, { recursive: true });
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    src = await asAgent('quelle');
    dst = await asAgent('ziel');
    jobId = (await srv.request('POST', `/api/projects/${projectId}/backup-jobs`, {
      cookie,
      body: { name: 'Standard', machine_id: src.id, target_dir: srcDir, sources: [{ id: 'd', kind: 'sqlite', label: 'DB', config: { path: path.join(tmp, 'x.db') } }], schedule: { mode: 'off' } },
    })).body.data.id;
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const putReplica = (body: Record<string, unknown>) => srv.request('PUT', `/api/projects/${projectId}/backup-jobs/${jobId}/replica`, { cookie, body });

  it('kopiert vorhandene Backups über den Server auf die zweite Maschine, prüft jede Datei und räumt den Zwischenspeicher auf', async () => {
    makeBundle(srcDir, '2026-10-01_030000', 'a');
    makeBundle(srcDir, '2026-10-02_030000', 'b');
    await report(['2026-10-01_030000', '2026-10-02_030000']);

    const set = await putReplica({ machine_id: dst.id, target_dir: dstDir });
    expect(set.status).toBe(200);
    const row = await settle();
    expect(row).toMatchObject({ last_ok: 1 });

    expect(listReplicaBundles(dstDir)).toEqual(['2026-10-02_030000', '2026-10-01_030000']);
    for (const name of ['2026-10-01_030000', '2026-10-02_030000']) {
      const a = listFiles(path.join(srcDir, name)).sort();
      expect(listFiles(path.join(dstDir, name)).sort()).toEqual(a);
      for (const rel of a) expect(sha(path.join(dstDir, name, rel))).toBe(sha(path.join(srcDir, name, rel)));
    }
    // kein Rest im Zwischenspeicher, keine halbfertigen Ordner im Ziel
    const staging = path.join(srv.ctx.config.dataDir, 'replica-staging');
    expect(fs.existsSync(staging) ? fs.readdirSync(staging).flatMap((d) => fs.readdirSync(path.join(staging, d))) : []).toEqual([]);
    expect(fs.readdirSync(dstDir).filter((n) => n.endsWith('.partial'))).toEqual([]);

    const dto = (await srv.request('GET', `/api/projects/${projectId}/backup-jobs`, { cookie })).body.data[0].replica;
    expect(dto).toMatchObject({ primary_count: 2, replicated_count: 2, last_ok: true, state: 'idle' });
    expect(dto.machine.name).toBe('ziel');
  });

  it('spiegelt die Aufbewahrung: was beim Primären gelöscht wird, verschwindet auch auf der Replik – fremde Ordner und leere Listen bleiben unangetastet', async () => {
    makeBundle(srcDir, '2026-10-01_030000', 'a');
    makeBundle(srcDir, '2026-10-02_030000', 'b');
    await report(['2026-10-01_030000', '2026-10-02_030000']);
    await putReplica({ machine_id: dst.id, target_dir: dstDir });
    await settle();

    // fremde Inhalte im Zielordner
    fs.mkdirSync(path.join(dstDir, 'meine-notizen'));
    fs.mkdirSync(path.join(dstDir, '2020-01-01_000000')); // sieht wie ein Backup aus, hat aber kein Manifest
    fs.writeFileSync(path.join(dstDir, 'readme.txt'), 'bleibt');

    // Aufbewahrung beim Primären löscht das älteste Backup
    fs.rmSync(path.join(srcDir, '2026-10-01_030000'), { recursive: true });
    await report(['2026-10-02_030000']);
    await settle();
    expect(listReplicaBundles(dstDir)).toEqual(['2026-10-02_030000']);
    expect(fs.existsSync(path.join(dstDir, 'meine-notizen'))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, '2020-01-01_000000'))).toBe(true);
    expect(fs.readFileSync(path.join(dstDir, 'readme.txt'), 'utf8')).toBe('bleibt');

    // leere Liste beim Primären (z. B. Ordner gerade nicht lesbar) darf die Replik nie leeren
    await report([]);
    await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${jobId}/replica/sync`, { cookie });
    await settle();
    expect(listReplicaBundles(dstDir)).toEqual(['2026-10-02_030000']);
  });

  it('holt ein später gelöschtes Backup der Replik erneut und meldet Fehler verständlich (Quelle ohne den Ordner)', async () => {
    makeBundle(srcDir, '2026-10-02_030000', 'b');
    await report(['2026-10-02_030000']);
    await putReplica({ machine_id: dst.id, target_dir: dstDir });
    await settle();
    fs.rmSync(path.join(dstDir, '2026-10-02_030000'), { recursive: true });
    await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${jobId}/replica/sync`, { cookie });
    await settle();
    expect(listReplicaBundles(dstDir)).toEqual(['2026-10-02_030000']);

    // Primär-Ordner wurde von Hand gelöscht, DevDeck kennt das Backup aber noch → Export scheitert mit klarer Meldung
    fs.rmSync(path.join(dstDir, '2026-10-02_030000'), { recursive: true });
    fs.rmSync(path.join(srcDir, '2026-10-02_030000'), { recursive: true });
    await srv.request('POST', `/api/projects/${projectId}/backup-jobs/${jobId}/replica/sync`, { cookie });
    const row = await settle();
    expect(row).toMatchObject({ last_ok: 0 });
    expect(row!.last_message).toMatch(/liegt nicht \(mehr\)/);
  });

  it('prüft Einrichtung und Zugriff: andere Maschine, Agent-Version, fremde Maschinen dürfen nicht übertragen, beschädigte Uploads werden abgelehnt', async () => {
    expect((await putReplica({ machine_id: src.id, target_dir: dstDir })).status).toBe(400); // gleiche Maschine wie das Primär-Backup
    expect((await putReplica({ machine_id: dst.id, target_dir: 'relativ' })).status).toBe(400);
    srv.ctx.db.run(`UPDATE machines SET agent_version='0.16.0' WHERE id=?`, dst.id);
    expect((await putReplica({ machine_id: dst.id, target_dir: dstDir })).status).toBe(400); // Agent zu alt
    srv.ctx.db.run(`UPDATE machines SET agent_version='0.17.0' WHERE id=?`, dst.id);

    makeBundle(srcDir, '2026-10-02_030000', 'b');
    await report(['2026-10-02_030000']);
    await putReplica({ machine_id: dst.id, target_dir: dstDir });
    runReplicaTick(srv.ctx);
    await agentTurn(dst); // Prüfung (prune) abholen
    runReplicaTick(srv.ctx); // → Export wird beauftragt
    const row = getReplica(srv.ctx, 'job', jobId)!;
    expect(row.state).toBe('exporting');
    const url = `/api/agent/replicas/${row.id}/staging/2026-10-02_030000/file?path=${encodeURIComponent('database/a.json')}`;
    const body = Buffer.from('[b]');
    const good = createHash('sha256').update(body).digest('hex');
    const put = (token: string, sha256: string, data: Buffer) => fetch(`${srv.base}${url}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Sha256': sha256 }, body: new Uint8Array(data) });
    expect((await put(dst.token, good, body)).status).toBe(403); // nur die Quelle darf hochladen
    expect((await put(src.token, 'f'.repeat(64), body)).status).toBe(400); // Prüfsumme passt nicht
    expect((await put(src.token, good, body)).status).toBe(204);
    const traversal = await fetch(`${srv.base}/api/agent/replicas/${row.id}/staging/2026-10-02_030000/file?path=${encodeURIComponent('../../x')}`, { method: 'PUT', headers: { Authorization: `Bearer ${src.token}`, 'X-Sha256': good, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(body) });
    expect(traversal.status).toBe(400);
    // Download nur durch die Ziel-Maschine und erst im Schritt „importing“
    const get = (token: string) => fetch(`${srv.base}/api/agent/replicas/${row.id}/bundles/2026-10-02_030000/files`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await get(dst.token)).status).toBe(403);
  });

  it('System-Backups des Servers werden direkt (ohne Zwischenspeicher) auf die Ziel-Maschine kopiert', async () => {
    const created = await srv.request('POST', '/api/backups', { cookie });
    expect(created.status).toBe(201);
    const name = path.basename(created.body.data.target_path);
    const set = await srv.request('PUT', '/api/backups/replica', { cookie, body: { machine_id: dst.id, target_dir: dstDir } });
    expect(set.status).toBe(200);
    const row = await settle('system');
    expect(row).toMatchObject({ last_ok: 1 });
    expect(listReplicaBundles(dstDir)).toEqual([name]);
    for (const rel of listFiles(created.body.data.target_path)) expect(sha(path.join(dstDir, name, rel))).toBe(sha(path.join(created.body.data.target_path, rel)));
    const overview = (await srv.request('GET', '/api/backup-replicas', { cookie })).body.data;
    expect(overview.system.replica).toMatchObject({ primary_count: 1, replicated_count: 1 });
    expect(overview.jobs[0].replica).toBeNull();
    // Replik entfernen: Kopien bleiben liegen
    expect((await srv.request('DELETE', '/api/backups/replica', { cookie, body: { confirm: true } })).status).toBe(204);
    expect(listReplicaBundles(dstDir)).toEqual([name]);
  });
});
