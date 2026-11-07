import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { runMonitorTick, setRetryDelayForTests, isPrivateAddress } from '../src/services/monitoring.js';
import { applySuggestions } from '../src/services/monitoringSuggest.js';

let web: http.Server;
let base: string;
let tcpServer: net.Server;
let tcpPort: number;
let secretSeen = '';

beforeAll(async () => {
  setRetryDelayForTests(0);
  web = http.createServer((req, res) => {
    secretSeen = String(req.headers.apikey ?? '');
    if (req.url === '/ok') return void res.end('hallo welt');
    if (req.url === '/redirect') return void res.writeHead(302, { Location: '/ok' }).end();
    if (req.url === '/fail') return void res.writeHead(503).end('kaputt');
    if (req.url === '/slow') return void setTimeout(() => res.end('langsam'), 250);
    if (req.url === '/rows') return void res.setHeader('content-type', 'application/json').end(JSON.stringify([{ a: 1 }, { a: 2 }]));
    if (req.url === '/empty') return void res.setHeader('content-type', 'application/json').end('[]');
    if (req.url === '/401') return void res.writeHead(401).end('no key');
    res.writeHead(404).end('nicht da');
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  tcpServer = net.createServer((s) => s.end());
  await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', r));
  tcpPort = (tcpServer.address() as AddressInfo).port;
});
afterAll(async () => {
  setRetryDelayForTests(3000);
  await new Promise((r) => web.close(r));
  await new Promise((r) => tcpServer.close(r));
});

describe('Monitoring (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;

  const create = (body: Record<string, unknown>, c = cookie) => srv.request('POST', '/api/monitors', { cookie: c, body: { project_id: projectId, environment: 'prod', ...body } });
  const http_ = (path: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => create({ name: `http ${path}`, kind: 'http', config: { url: `${base}${path}`, ...config }, ...extra });
  const list = async () => (await srv.request('GET', '/api/monitoring', { cookie })).body.data;
  const monitor = async (id: string) => (await list()).monitors.find((m: any) => m.id === id);

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    const m = await srv.enroll(cookie, 'srv1');
    machineId = m.machineId;
    machineToken = m.token;
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', agent_version='0.18.0', platform='linux', last_seen_at=? WHERE id=?`, new Date().toISOString(), machineId);
  });
  afterEach(async () => {
    await srv.close();
  });

  it('HTTP: ok, langsam = Warnung, 5xx und falscher Text = Fehler, „reachable“ akzeptiert 401, JSON-Zeilen, Redirects', async () => {
    expect((await http_('/ok')).body.data).toMatchObject({ status: 'ok', environment: 'prod' });
    expect((await http_('/redirect')).body.data.status).toBe('ok');
    expect((await http_('/slow', { warn_latency_ms: 100 })).body.data).toMatchObject({ status: 'warn' });
    const fail = (await http_('/fail')).body.data;
    expect(fail).toMatchObject({ status: 'error', message: 'HTTP 503' });
    expect((await http_('/401')).body.data.status).toBe('error');
    expect((await http_('/401', { expect: 'reachable' })).body.data.status).toBe('ok');
    expect((await http_('/401', { expect: 'status', status: 401 })).body.data.status).toBe('ok');
    expect((await http_('/ok', { contains: 'welt' })).body.data.status).toBe('ok');
    const missing = (await http_('/ok', { contains: 'xyz' })).body.data;
    expect(missing).toMatchObject({ status: 'error' });
    expect(missing.message).toContain('enthält');
    expect((await http_('/rows', { json_array_min: 2 })).body.data.status).toBe('ok');
    expect((await http_('/empty', { json_array_min: 1 })).body.data.message).toContain('Nur 0 Zeile');
    expect((await http_('/ok', { json_array_min: 1 })).body.data.message).toContain('keine JSON-Liste');
  });

  it('TCP: erreichbarer Port ok, geschlossener Port Fehler; Eingaben werden geprüft', async () => {
    const ok = await create({ name: 'port', kind: 'tcp', config: { host: '127.0.0.1', port: tcpPort } });
    expect(ok.body.data).toMatchObject({ status: 'ok', target: `127.0.0.1:${tcpPort}` });
    const closed = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
    expect((await create({ name: 'zu', kind: 'tcp', config: { host: '127.0.0.1', port: closed } })).body.data.status).toBe('error');
    expect((await create({ name: 'x', kind: 'tcp', config: { host: 'a b', port: 25 } })).status).toBe(400);
    expect((await create({ name: 'x', kind: 'tcp', config: { host: 'example.com', port: 70000 } })).status).toBe(400);
    expect((await create({ name: 'x', kind: 'http', config: { url: 'ftp://x' } })).status).toBe(400);
    expect((await create({ name: 'x', kind: 'komisch' })).status).toBe(400);
  });

  it('Secrets: Header-Werte kommen aus dem Vault, werden nie ausgegeben; fehlendes Secret ist ein klarer Fehler', async () => {
    const sid = (await srv.request('POST', `/api/projects/${projectId}/secrets`, { cookie, body: { name: 'ANON', kind: 'env', environment: 'production' } })).body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/secrets/${sid}/values`, { cookie, body: { value: 'anon-key-123' } });
    const m = (await http_('/ok', { headers: [{ name: 'apikey', secret: { name: 'ANON', environment: 'production' } }] })).body.data;
    expect(m.status).toBe('ok');
    expect(secretSeen).toBe('anon-key-123');
    expect(JSON.stringify(m)).not.toContain('anon-key-123');
    expect(m.config.headers).toEqual([{ name: 'apikey', secret: { name: 'ANON', environment: 'production' } }]);
    const miss = (await http_('/ok', { headers: [{ name: 'apikey', secret: { name: 'GIBTS_NICHT', environment: 'production' } }] })).body.data;
    expect(miss).toMatchObject({ status: 'error' });
    expect(miss.message).toContain('fehlt im Vault');
    const plain = (await http_('/ok', { headers: [{ name: 'x-test', value: 'geheim' }] })).body.data;
    expect(plain.config.headers).toEqual([{ name: 'x-test', value: '••••' }]);
  });

  it('Private Ziele darf nur ein Admin überwachen; Maintainer sehen nur ihre Projekte und dürfen nur dort verwalten', async () => {
    await srv.request('POST', '/api/users', { cookie, body: { email: 'm@devdeck.test', password: 'maint-pass-123', system_role: 'developer' } });
    await srv.request('POST', '/api/users', { cookie, body: { email: 'v@devdeck.test', password: 'view-pass-123', system_role: 'developer' } });
    await srv.request('POST', `/api/projects/${projectId}/members`, { cookie, body: { email: 'm@devdeck.test', role: 'maintainer' } });
    await srv.request('POST', `/api/projects/${projectId}/members`, { cookie, body: { email: 'v@devdeck.test', role: 'viewer' } });
    const maint = await srv.login('m@devdeck.test', 'maint-pass-123');
    const viewer = await srv.login('v@devdeck.test', 'view-pass-123');
    const other = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'Fremd' } })).body.data.id;

    const priv = await create({ name: 'intern', kind: 'http', config: { url: `${base}/ok` } }, maint);
    expect(priv.status).toBe(403);
    expect(priv.body.error.message).toContain('privaten Netz');
    expect((await create({ name: 'ext', kind: 'http', config: { url: 'https://localhost.invalid/' } }, maint)).status).toBe(201); // nicht auflösbar → kein privates Ziel, Fehler erst bei der Prüfung
    expect((await create({ name: 'v', kind: 'machine', machine_id: machineId }, viewer)).status).toBe(403);
    expect((await srv.request('POST', '/api/monitors', { cookie: maint, body: { project_id: other, name: 'x', kind: 'machine', machine_id: machineId } })).status).toBe(403);
    expect((await srv.request('POST', '/api/monitors', { cookie: maint, body: { name: 'sys', kind: 'machine', machine_id: machineId } })).status).toBe(403); // System-Monitor nur Admin

    const seen = (await srv.request('GET', '/api/monitoring', { cookie: viewer })).body.data;
    expect(seen.projects.map((p: any) => p.name)).toEqual(['App']);
    expect(seen.monitors.every((m: any) => m.project.id === projectId)).toBe(true);
    const mon = (await create({ name: 'ok', kind: 'machine', machine_id: machineId })).body.data.id;
    expect((await srv.request('DELETE', `/api/monitors/${mon}`, { cookie: viewer, body: { confirm: true } })).status).toBe(403);
    const stranger = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    expect(stranger).toBeTruthy();
    expect(isPrivateAddress('10.1.2.3') && isPrivateAddress('192.168.1.1') && isPrivateAddress('127.0.0.1') && isPrivateAddress('::1') && !isPrivateAddress('8.8.8.8') && !isPrivateAddress('2606:4700::1')).toBe(true);
  });

  it('interne Monitore: Maschine, Datenträger, Updates, Backup-Alter, Replik, Integration', async () => {
    const run = async (body: Record<string, unknown>) => (await create(body)).body.data;
    expect((await run({ name: 'm', kind: 'machine', machine_id: machineId }))).toMatchObject({ status: 'ok' });
    srv.ctx.db.run(`UPDATE machines SET agent_status='offline' WHERE id=?`, machineId);
    const off = await run({ name: 'm2', kind: 'machine', machine_id: machineId });
    expect(off).toMatchObject({ status: 'error' });
    expect(off.message).toContain('offline');

    expect((await run({ name: 'd', kind: 'disk', machine_id: machineId })).status).toBe('unknown');
    srv.ctx.db.run(`UPDATE machines SET inventory_json=? WHERE id=?`, JSON.stringify({ disks: [{ name: 'C:', total_gb: 100, free_gb: 40 }, { name: 'D:', total_gb: 100, free_gb: 12 }] }), machineId);
    const disk = await run({ name: 'd2', kind: 'disk', machine_id: machineId });
    expect(disk).toMatchObject({ status: 'warn' });
    expect(disk.message).toContain('12 % frei auf D:');
    srv.ctx.db.run(`UPDATE machines SET inventory_json=? WHERE id=?`, JSON.stringify({ disks: [{ name: 'C:', total_gb: 100, free_gb: 3 }] }), machineId);
    expect((await run({ name: 'd3', kind: 'disk', machine_id: machineId })).status).toBe('error');

    srv.ctx.db.run(`UPDATE machines SET patches_json=? WHERE id=?`, JSON.stringify({ security: 2, critical: 0, total: 5, reboot_required: false }), machineId);
    expect((await run({ name: 'p', kind: 'patches', machine_id: machineId })).status).toBe('warn');
    srv.ctx.db.run(`UPDATE machines SET patches_json=? WHERE id=?`, JSON.stringify({ security: 1, critical: 1, total: 5 }), machineId);
    expect((await run({ name: 'p2', kind: 'patches', machine_id: machineId })).status).toBe('error');

    // Backup-Job mit Läufen
    srv.ctx.db.run(`UPDATE machines SET agent_status='online' WHERE id=?`, machineId);
    const job = (await srv.request('POST', `/api/projects/${projectId}/backup-jobs`, { cookie, body: { name: 'Job', machine_id: machineId, target_dir: '/backups/x', sources: [{ id: 'd', kind: 'sqlite', label: 'DB', config: { path: '/data/x.db' } }], schedule: { mode: 'daily', time: '03:00', weekday: 1, every_hours: 24 } } })).body.data.id;
    const b = await run({ name: 'b', kind: 'backup', config: { target: job } });
    expect(b.status).toBe('warn');
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const insert = (id: string, status: string, h: number) => srv.ctx.db.run(`INSERT INTO project_backups (id, job_id, project_id, bundle_name, status, trigger_kind, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'schedule', 'devdeck', ?, ?)`, id, job, projectId, `2026-01-0${id}_000000`, status, at(h), at(h));
    insert('1', 'success', 2);
    expect((await srv.request('POST', `/api/monitors/${b.id}/check`, { cookie })).body.data.status).toBe('ok');
    srv.ctx.db.run('DELETE FROM project_backups WHERE job_id = ?', job);
    insert('2', 'success', 40);
    expect((await srv.request('POST', `/api/monitors/${b.id}/check`, { cookie })).body.data.status).toBe('warn');
    srv.ctx.db.run('DELETE FROM project_backups WHERE job_id = ?', job);
    insert('3', 'success', 100);
    expect((await srv.request('POST', `/api/monitors/${b.id}/check`, { cookie })).body.data.status).toBe('error');
    srv.ctx.db.run('DELETE FROM project_backups WHERE job_id = ?', job);
    insert('4', 'success', 5);
    insert('5', 'failed', 1);
    expect((await srv.request('POST', `/api/monitors/${b.id}/check`, { cookie })).body.data.message).toContain('Letzter Lauf fehlgeschlagen');

    expect((await run({ name: 'r', kind: 'replica', config: { target: job } })).status).toBe('unknown');
    const other = (await srv.enroll(cookie, 'ziel')).machineId;
    srv.ctx.db.run(`INSERT INTO backup_replicas (id, scope, job_id, job_key, machine_id, target_dir, enabled, state, sync_requested, last_ok, last_sync_at, last_message, created_at, updated_at) VALUES ('r', 'job', ?, ?, ?, '/r', 1, 'idle', 0, 0, ?, 'Ziel-Maschine ist offline', ?, ?)`, job, job, other, at(1), at(1), at(1));
    const rep = (await srv.request('POST', `/api/monitors/${(await run({ name: 'r2', kind: 'replica', config: { target: job } })).id}/check`, { cookie })).body.data;
    expect(rep).toMatchObject({ status: 'error', message: 'Ziel-Maschine ist offline' });
    srv.ctx.db.run(`UPDATE backup_replicas SET last_ok = 1, last_message = 'synchron' WHERE id = 'r'`);
    expect((await srv.request('POST', `/api/monitors/${rep.id}/check`, { cookie })).body.data.status).toBe('ok');

    expect((await create({ name: 'c', kind: 'connector', config: { connector_id: 'gibt-es-nicht' } })).status).toBe(400);
    // Backup-Job eines fremden Projekts ist nicht erlaubt
    const foreign = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'Fremd' } })).body.data.id;
    expect((await srv.request('POST', '/api/monitors', { cookie, body: { project_id: foreign, name: 'b', kind: 'backup', config: { target: job } } })).status).toBe(400);
  });

  it('Projekt-Ampel: Produktion zählt voll, Entwicklung und Obergrenze höchstens als Warnung, pausiert zählt nicht', async () => {
    const proj = async () => (await srv.request('GET', '/api/projects', { cookie })).body.data.find((p: any) => p.id === projectId).monitoring;
    expect(await proj()).toMatchObject({ status: 'none', total: 0 });
    const good = (await http_('/ok')).body.data.id;
    expect(await proj()).toMatchObject({ status: 'ok', total: 1, ok: 1 });
    const bad = (await http_('/fail')).body.data.id;
    expect(await proj()).toMatchObject({ status: 'error', error: 1 });
    await srv.request('PATCH', `/api/monitors/${bad}`, { cookie, body: { severity_cap: 'warn' } });
    expect(await proj()).toMatchObject({ status: 'warn', warn: 1, error: 0 });
    await srv.request('PATCH', `/api/monitors/${bad}`, { cookie, body: { severity_cap: 'error', environment: 'dev' } });
    expect((await proj()).status).toBe('warn'); // Entwicklung: höchstens gelb
    await srv.request('PATCH', `/api/monitors/${bad}`, { cookie, body: { enabled: false } });
    expect(await proj()).toMatchObject({ status: 'ok', total: 1 });
    expect((await monitor(bad)).effective_status).toBe('unknown');
    expect((await srv.request('DELETE', `/api/monitors/${good}`, { cookie, body: {} })).status).toBe(428);
    expect((await srv.request('DELETE', `/api/monitors/${good}`, { cookie, body: { confirm: true } })).status).toBe(204);
  });

  it('Verlauf und Tick: fällige Monitore werden geprüft, Verlauf/Verfügbarkeit werden geführt', async () => {
    const id = (await http_('/ok', {}, { interval_seconds: 30 })).body.data.id;
    expect(await runMonitorTick(srv.ctx)).toBe(0); // gerade geprüft, noch nicht fällig
    expect(await runMonitorTick(srv.ctx, Date.now() + 40_000)).toBe(1);
    const m = await monitor(id);
    expect(m.history).toHaveLength(2);
    expect(m.uptime_24h).toBe(100);
    expect(m.status_since).toBeTruthy();
  });

  it('Agent-Monitore: Prüfaufträge im Heartbeat, Ergebnisse nur von der eigenen Maschine, ohne Rückmeldung „unbekannt“', async () => {
    const old = (await srv.enroll(cookie, 'alt')).machineId;
    srv.ctx.db.run(`UPDATE machines SET agent_version='0.17.0' WHERE id=?`, old);
    expect((await create({ name: 'x', kind: 'systemd', machine_id: old, config: { unit: 'helferle-api' } })).status).toBe(400); // Agent zu alt
    expect((await create({ name: 'x', kind: 'systemd', config: { unit: 'helferle-api' } })).status).toBe(400); // Maschine fehlt
    expect((await create({ name: 'x', kind: 'systemd', machine_id: machineId, config: { unit: '--help' } })).status).toBe(400); // keine Optionen

    const unit = (await create({ name: 'API', kind: 'systemd', machine_id: machineId, config: { unit: 'helferle-api' }, group: 'Dienste' })).body.data;
    const local = (await create({ name: 'Health', kind: 'http', machine_id: machineId, config: { url: 'http://localhost:5001/v1/health' } })).body.data;
    expect(unit).toMatchObject({ status: 'unknown', agent_bound: true });
    expect(local.target).toContain('von srv1');

    const beat = (body: Record<string, unknown> = {}, token = machineToken) => srv.request('POST', '/api/agent/heartbeat', { token, body: { agent_version: '0.18.0', ...body } });
    const first = await beat();
    expect(first.body.data.probes.map((p: any) => [p.kind, p.id])).toEqual(expect.arrayContaining([['systemd', unit.id], ['http', local.id]]));
    expect(first.body.data.probes.find((p: any) => p.id === unit.id).config).toEqual({ unit: 'helferle-api', scope: 'user' });

    await beat({ probe_results: [{ id: unit.id, status: 'ok', latency_ms: null, message: 'Dienst helferle-api: active', checked_at: new Date().toISOString() }, { id: local.id, status: 'error', latency_ms: 12, message: 'Verbindung fehlgeschlagen (ECONNREFUSED)', checked_at: new Date().toISOString() }] });
    expect(await monitor(unit.id)).toMatchObject({ status: 'ok', message: 'Dienst helferle-api: active' });
    expect(await monitor(local.id)).toMatchObject({ status: 'error' });

    // fremde Maschine darf keine Ergebnisse für diesen Monitor melden
    const intruder = await srv.enroll(cookie, 'fremd');
    srv.ctx.db.run(`UPDATE machines SET agent_version='0.18.0' WHERE id=?`, intruder.machineId);
    await beat({ probe_results: [{ id: unit.id, status: 'error', latency_ms: null, message: 'gefälscht', checked_at: new Date().toISOString() }] }, intruder.token);
    expect((await monitor(unit.id)).message).toBe('Dienst helferle-api: active');
    expect((await beat({}, intruder.token)).body.data.probes).toEqual([]);

    // „Jetzt prüfen“ setzt einen neuen force-Wert, damit der Agent sofort prüft
    const f1 = (await beat()).body.data.probes.find((p: any) => p.id === unit.id).force;
    await srv.request('POST', `/api/monitors/${unit.id}/check`, { cookie });
    expect((await beat()).body.data.probes.find((p: any) => p.id === unit.id).force).not.toBe(f1);

    // keine Rückmeldung mehr → unbekannt
    await runMonitorTick(srv.ctx, Date.now() + 20 * 60_000);
    expect((await monitor(unit.id)).status).toBe('unknown');
  });

  it('Vorschläge aus den Fakten des Workspaces (Monorepo): Supabase-Host aus .env ohne Vault, Vercel-Standardadressen – nicht, wenn die Architektur eine Domain nennt', async () => {
    const ws = (await srv.request('POST', `/api/projects/${projectId}/workspaces`, { cookie, body: { machine_id: machineId, local_path: '/data/wawi' } })).body.data.id;
    const setFacts = (facts: unknown) => srv.ctx.db.run('UPDATE workspaces SET facts_json = ? WHERE id = ?', JSON.stringify(facts), ws);
    const base = { env: [{ name: 'VITE_SUPABASE_URL', host: 'roepskibpwdsjbryepsz.supabase.co' }, { name: 'SUPABASE_URL', host: 'roepskibpwdsjbryepsz.supabase.co' }], markers: ['vercel.json'], packages: [], databases: [], architecture: null, architecture_error: null, collected_at: new Date().toISOString() };
    setFacts({ ...base, vercel_projects: ['wawimobile', 'wawimobile-verwaltung'] });
    const keys = async () => (await srv.request('GET', `/api/monitors/suggestions?project_id=${projectId}`, { cookie })).body.data.map((s: any) => s.auto_key);
    expect(await keys()).toEqual(expect.arrayContaining(['supabase-auth:prod', 'supabase-rest:prod', 'web:wawimobile.vercel.app', 'web:wawimobile-verwaltung.vercel.app']));
    const created = await applySuggestions(srv.ctx, projectId, { id: null, label: 'test', isAdmin: false });
    expect(created.failed).toEqual([]);
    const m = (await list()).monitors;
    expect(m.find((x: any) => x.name.startsWith('Supabase Anmeldung')).config).toMatchObject({ url: 'https://roepskibpwdsjbryepsz.supabase.co/auth/v1/health', expect: 'reachable' });
    expect(m.map((x: any) => x.target)).toContain('https://wawimobile.vercel.app/');

    // nennt die Architektur-Karte eine eigene Domain, kommt die vercel.app-Adresse nicht zusätzlich dazu
    setFacts({ ...base, vercel_projects: ['peefinder'], architecture: { components: [{ id: 'vercel', kind: 'hosting', name: 'Vercel', provider: 'Vercel', details: { Domain: 'www.peefinder.com' } }], links: [] } });
    const after = await keys();
    expect(after).toContain('web:www.peefinder.com');
    expect(after).not.toContain('web:peefinder.vercel.app');
  });

  it('Vorschläge: Backup, Replik, Supabase-Zugangsdaten (nur anon-Schlüssel), Mail und Domains aus der Architektur; idempotent', async () => {
    const secret = async (name: string, value: string, environment = 'production') => {
      const id = (await srv.request('POST', `/api/projects/${projectId}/secrets`, { cookie, body: { name, kind: 'env', environment } })).body.data.id;
      await srv.request('POST', `/api/projects/${projectId}/secrets/${id}/values`, { cookie, body: { value } });
    };
    await secret('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    await secret('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    await secret('SUPABASE_SERVICE_ROLE_KEY', 'GEHEIM-SERVICE');
    const job = (await srv.request('POST', `/api/projects/${projectId}/backup-jobs`, { cookie, body: { name: 'Täglich', machine_id: machineId, target_dir: '/backups/x', sources: [{ id: 'd', kind: 'sqlite', label: 'DB', config: { path: '/data/x.db' } }], schedule: { mode: 'daily', time: '03:00', weekday: 1, every_hours: 24 } } })).body.data.id;
    await srv.request('POST', `/api/projects/${projectId}/backup-jobs`, { cookie, body: { name: 'Manuell', machine_id: machineId, target_dir: '/backups/y', sources: [{ id: 'd', kind: 'sqlite', label: 'DB', config: { path: '/data/y.db' } }], schedule: { mode: 'off' } } });
    const sugg = (await srv.request('GET', `/api/monitors/suggestions?project_id=${projectId}`, { cookie })).body.data;
    expect(sugg.map((s: any) => s.auto_key)).toEqual(expect.arrayContaining([`backup:${job}`, `machine:${machineId}`, 'supabase-auth:prod', 'supabase-rest:prod']));
    expect(sugg.some((s: any) => s.auto_key.startsWith('backup:') && s.name.includes('Manuell'))).toBe(false); // ohne Zeitplan kein Backup-Monitor

    const first = await applySuggestions(srv.ctx, projectId, { id: null, label: 'test', isAdmin: false });
    expect(first.failed).toEqual([]);
    expect(first.created).toBeGreaterThanOrEqual(4);
    expect((await applySuggestions(srv.ctx, projectId, { id: null, label: 'test', isAdmin: false })).created).toBe(0);
    const auth = (await list()).monitors.find((m: any) => m.name.startsWith('Supabase Anmeldung'));
    expect(auth.config.url).toBe('https://abcdefgh.supabase.co/auth/v1/health');
    expect(auth.config.headers).toEqual([{ name: 'apikey', secret: { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', environment: 'production' } }]);
    expect(JSON.stringify(await list())).not.toContain('GEHEIM-SERVICE');
    // Seed über die API
    expect((await srv.request('POST', '/api/monitors/seed', { cookie, body: { project_id: projectId } })).body.data.created).toBe(0);
  });
});
