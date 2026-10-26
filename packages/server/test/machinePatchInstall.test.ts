import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

const patches = (security: number, critical = 0, extra: Record<string, unknown> = {}) => ({
  collected_at: new Date().toISOString(), scanner: 'apt', total: security + 1, critical, security, reboot_required: false, last_installed_at: null,
  items: [{ vendor: null, name: 'openssl', version: '1', available: '2', status: critical ? 'critical' : 'security', kind: 'os', detail: null, id: 'openssl' }], installed: [], notes: [], ...extra,
});

describe('Patch-Installation und Sicherheitshinweis (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let machineId: string;
  let token: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const e = await srv.enroll(cookie, 'patch-pc');
    machineId = e.machineId;
    token = e.token;
  });
  afterEach(async () => {
    await srv.close();
  });

  const beat = (body: Record<string, unknown> = {}) => srv.request('POST', '/api/agent/heartbeat', { token, body: { agent_version: '0.15.0', ...body } });
  const install = (ids: unknown) => srv.request('POST', `/api/machines/${machineId}/patches/install`, { cookie, body: { ids } });
  const summary = async () => (await srv.request('GET', '/api/machines/security-summary', { cookie })).body.data;

  it('zeigt Maschinen mit sicherheitsrelevanten Updates (kritische zuerst) und behält die Update-ID', async () => {
    expect(await summary()).toEqual([]);
    await beat({ patches: patches(0) });
    expect(await summary()).toEqual([]);
    await beat({ patches: patches(2, 1) });
    expect(await summary()).toEqual([{ id: machineId, name: 'patch-pc', security: 2, critical: 1, reboot_required: false }]);
    const detail = (await srv.request('GET', `/api/machines/${machineId}/patches`, { cookie })).body.data;
    expect(detail.patches.items[0].id).toBe('openssl');
  });

  it('prüft Eingaben, Agent-Version und verhindert parallele Installationen', async () => {
    await beat();
    expect((await install([])).status).toBe(400);
    expect((await install(['--help'])).status).toBe(400);
    expect((await install(['a; reboot'])).status).toBe(400);
    expect((await install(Array.from({ length: 101 }, (_, i) => `p${i}`))).status).toBe(400);
    const ok = await install(['openssl', 'openssl']);
    expect(ok.status).toBe(202);
    expect((await install(['curl'])).status).toBe(409);
    const cmds = await srv.request('GET', '/api/agent/commands?wait=0', { token });
    expect(cmds.body.data[0]).toMatchObject({ action: 'patches.install', payload: { ids: ['openssl'] } });

    await beat({ agent_version: '0.14.0' });
    await srv.request('POST', `/api/agent/commands/${cmds.body.data[0].id}/result`, { token, body: { status: 'done', data: { results: [], reboot_required: false } } });
    expect((await install(['openssl'])).status).toBe(400); // Agent zu alt
  });

  it('übernimmt das Ergebnis: neuer Patch-Stand sofort, Ausgang je Update im Befehlsstatus, kein Neustart', async () => {
    await beat({ patches: patches(2) });
    const res = await install(['openssl']);
    const commandId = res.body.data.command_id;
    const cmds = await srv.request('GET', '/api/agent/commands?wait=0', { token });
    expect(cmds.body.data[0].id).toBe(commandId);
    await srv.request('POST', `/api/agent/commands/${commandId}/result`, {
      token,
      body: { status: 'done', data: { results: [{ id: 'openssl', name: 'openssl', ok: true, message: 'Installiert' }], reboot_required: true, patches: patches(0, 0, { reboot_required: true, total: 0, items: [] }) } },
    });
    const status = (await srv.request('GET', `/api/machines/${machineId}/commands/${commandId}`, { cookie })).body.data;
    expect(status.status).toBe('done');
    expect(status.outcome).toEqual({ results: [{ id: 'openssl', name: 'openssl', ok: true, message: 'Installiert' }], reboot_required: true });
    expect(await summary()).toEqual([]);
    const after = (await srv.request('GET', `/api/machines/${machineId}/patches`, { cookie })).body.data.patches;
    expect(after.reboot_required).toBe(true);
    expect((await srv.request('GET', `/api/machines`, { cookie })).body.data[0].agent_can_install_patches).toBe(true);
  });
});
