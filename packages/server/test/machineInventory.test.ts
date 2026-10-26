import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Maschinen-Inventar (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let machineId: string;
  let machineToken: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const enrolled = await srv.enroll(cookie, 'inv-pc');
    machineId = enrolled.machineId;
    machineToken = enrolled.token;
  });
  afterEach(async () => {
    await srv.close();
  });

  const inventory = {
    collected_at: '2026-10-24T12:00:00.000Z',
    platform: 'win32',
    hostname: 'INV-PC',
    user: 'maurice',
    device: { manufacturer: 'HP', model: 'Z2 G8', serial: 'CZC1', ram_gb: 31.75, evil: '<x>' },
    os: { name: 'Windows 11 Pro', version: '26H2' },
    disks: [{ name: 'C:', label: 'SYSTEM', total_gb: 474.9, free_gb: 117.4 }, { name: 'kaputt' }],
    security: [{ label: 'Firewall', value: 'Aktiviert', level: 'ok' }, { label: 'X', value: 'y', level: 'seltsam' }],
    network: { ips: ['192.168.1.5'] },
    runtime: { boot_time: '2026-10-22T18:02:51.000Z', node: 'v22' },
    secrets: { token: 'darf nicht gespeichert werden' },
    cpu: { name: 'i9', cores: 8, threads: 16, speed_ghz: 3.5, architecture: 'x64', evil: 1 },
    bios_info: { manufacturer: 'HP', release_date: '2025-09-01' },
    memory_modules: [{ manufacturer: 'Samsung', capacity_gb: 16, locator: 'DIMM1', speed_mhz: 3200 }, { manufacturer: 'ohne Größe' }],
    network_adapters: [{ name: 'eth0', mac: 'aa:bb', ipv4: ['10.0.0.2'], ipv6: [], connected: true }, { mac: 'ohne Name' }],
  };

  it('speichert das Inventar aus dem Heartbeat bereinigt und liefert es im Detail', async () => {
    const hb = await srv.request('POST', '/api/agent/heartbeat', {
      token: machineToken,
      body: { agent_version: '0.9.0', platform: 'win32', inventory },
    });
    expect(hb.status).toBe(200);
    const res = await srv.request('GET', `/api/machines/${machineId}`, { cookie });
    expect(res.status).toBe(200);
    const inv = res.body.data.inventory;
    expect(inv.device).toMatchObject({ manufacturer: 'HP', serial: 'CZC1', ram_gb: 31.75 });
    expect(inv.device.evil).toBeUndefined();
    expect(inv.secrets).toBeUndefined();
    expect(inv.disks).toHaveLength(1); // Eintrag ohne Größen wird verworfen
    expect(inv.security.map((s: { level: string }) => s.level)).toEqual(['ok', 'unknown']);
    expect(res.body.data.inventory_at).toBeTruthy();
    expect(res.body.data.custom_fields).toEqual([]);
  });

  it('übernimmt Detail-Inventar (CPU, BIOS, Speicher, Netzwerk) bereinigt', async () => {
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.10.0', inventory } });
    const inv = (await srv.request('GET', `/api/machines/${machineId}`, { cookie })).body.data.inventory;
    expect(inv.cpu).toMatchObject({ name: 'i9', cores: 8, threads: 16, speed_ghz: 3.5 });
    expect(inv.cpu.evil).toBeUndefined();
    expect(inv.bios_info).toMatchObject({ manufacturer: 'HP', release_date: '2025-09-01' });
    expect(inv.memory_modules).toHaveLength(1);
    expect(inv.network_adapters).toEqual([{ name: 'eth0', mac: 'aa:bb', ipv4: ['10.0.0.2'], ipv6: [], connected: true }]);
  });

  it('speichert die Software-Liste bereinigt und liefert sie getrennt vom Detail', async () => {
    const apps = { collected_at: '2026-10-24T12:30:00.000Z', items: [
      { name: 'Git', version: '2.55', publisher: 'The Git Development Community', identifier: 'Git_is1', source: 'Add or remove programs', evil: 'x' },
      { name: '', version: '1' },
      { name: 'Node.js', version: null, source: 'MSI' },
    ] };
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.11.0', applications: apps } });
    const res = await srv.request('GET', `/api/machines/${machineId}/applications`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.data.applications).toEqual([
      { name: 'Git', version: '2.55', publisher: 'The Git Development Community', identifier: 'Git_is1', source: 'Add or remove programs' },
      { name: 'Node.js', version: null, publisher: null, identifier: null, source: 'MSI' },
    ]);
    expect(res.body.data.applications_at).toBe('2026-10-24T12:30:00.000Z');
    const detail = await srv.request('GET', `/api/machines/${machineId}`, { cookie });
    expect(detail.body.data.applications).toBeUndefined(); // lange Liste nicht im Detail-Aufruf
  });

  it('speichert den Patch-Stand bereinigt und liefert ihn getrennt', async () => {
    const patches = {
      collected_at: '2026-10-24T13:00:00.000Z', scanner: 'apt', total: 3, critical: 1, security: 2, reboot_required: true, last_installed_at: '2026-10-20',
      items: [
        { vendor: null, name: 'openssl', version: '3.0.14', available: '3.0.15', status: 'critical', kind: 'os', detail: 'stable-security', evil: 1 },
        { vendor: 'X', name: 'vim', status: 'komisch', kind: 'zzz' },
        { name: '' },
      ],
      installed: [{ id: 'KB1', description: 'Update', installed_on: '2026-10-14' }, { description: 'ohne Kennung' }],
      notes: ['Paketliste alt', 42],
      secrets: 'nicht speichern',
    };
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.12.0', patches } });
    const res = await srv.request('GET', `/api/machines/${machineId}/patches`, { cookie });
    expect(res.status).toBe(200);
    const p = res.body.data.patches;
    expect(p).toMatchObject({ scanner: 'apt', total: 3, critical: 1, security: 2, reboot_required: true, last_installed_at: '2026-10-20', notes: ['Paketliste alt'] });
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ name: 'openssl', status: 'critical', kind: 'os' });
    expect(p.items[0].evil).toBeUndefined();
    expect(p.items[1]).toMatchObject({ status: 'update', kind: 'app' }); // unbekannte Werte werden normalisiert
    expect(p.installed).toEqual([{ id: 'KB1', description: 'Update', installed_on: '2026-10-14' }]);
    expect(p.secrets).toBeUndefined();
    expect(res.body.data.patches_at).toBe('2026-10-24T13:00:00.000Z');
    // ohne Patch-Daten im nächsten Heartbeat bleibt der Stand erhalten; Fremde sehen ihn nicht
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.12.0' } });
    expect((await srv.request('GET', `/api/machines/${machineId}/patches`, { cookie })).body.data.patches.scanner).toBe('apt');
    await srv.request('POST', '/api/users', { cookie, body: { email: 'fremd5@devdeck.test', password: 'fremd-pass-123' } });
    const foreign = await srv.login('fremd5@devdeck.test', 'fremd-pass-123');
    expect((await srv.request('GET', `/api/machines/${machineId}/patches`, { cookie: foreign })).status).toBe(403);
  });

  it('behält die Software-Liste, wenn ein Heartbeat keine mitbringt; begrenzt ihre Länge', async () => {
    const many = { collected_at: '2026-10-24T12:30:00.000Z', items: Array.from({ length: 2600 }, (_, i) => ({ name: `App ${i}`, source: 'dpkg' })) };
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.11.0', applications: many } });
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.11.0' } });
    const res = await srv.request('GET', `/api/machines/${machineId}/applications`, { cookie });
    expect(res.body.data.applications).toHaveLength(2500);
  });

  it('zeigt die Software-Liste nur berechtigten Nutzern', async () => {
    await srv.request('POST', '/api/users', { cookie, body: { email: 'fremd4@devdeck.test', password: 'fremd-pass-123' } });
    const foreign = await srv.login('fremd4@devdeck.test', 'fremd-pass-123');
    expect((await srv.request('GET', `/api/machines/${machineId}/applications`, { cookie: foreign })).status).toBe(403);
  });

  it('behält das letzte Inventar, wenn ein Heartbeat keines mitbringt', async () => {
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.9.0', inventory } });
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.9.0' } });
    const res = await srv.request('GET', `/api/machines/${machineId}`, { cookie });
    expect(res.body.data.inventory.hostname).toBe('INV-PC');
  });

  it('speichert freie Felder mit Audit und begrenzt ihre Anzahl', async () => {
    const put = await srv.request('PUT', `/api/machines/${machineId}/custom-fields`, {
      cookie,
      body: { fields: [{ label: 'Standort', value: 'Laden' }, { label: '', value: 'ohne Label' }] },
    });
    expect(put.status).toBe(200);
    const res = await srv.request('GET', `/api/machines/${machineId}`, { cookie });
    expect(res.body.data.custom_fields).toEqual([{ label: 'Standort', value: 'Laden' }]);
    expect(srv.ctx.db.get(`SELECT 1 FROM audit_log WHERE action = 'machine.custom_fields.update'`)).toBeTruthy();
    const tooMany = await srv.request('PUT', `/api/machines/${machineId}/custom-fields`, {
      cookie,
      body: { fields: Array.from({ length: 31 }, (_, i) => ({ label: `f${i}`, value: 'x' })) },
    });
    expect(tooMany.status).toBe(400);
  });

  it('erlaubt fremden Nutzern weder Detail noch Feldänderung', async () => {
    await srv.request('POST', '/api/users', { cookie, body: { email: 'fremd3@devdeck.test', password: 'fremd-pass-123' } });
    const foreign = await srv.login('fremd3@devdeck.test', 'fremd-pass-123');
    expect((await srv.request('GET', `/api/machines/${machineId}`, { cookie: foreign })).status).toBe(403);
    expect((await srv.request('PUT', `/api/machines/${machineId}/custom-fields`, { cookie: foreign, body: { fields: [] } })).status).toBe(403);
  });
});
