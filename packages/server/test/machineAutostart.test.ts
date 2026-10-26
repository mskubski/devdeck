import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Maschinen-Autostart (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let machineId: string;
  let token: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const e = await srv.enroll(cookie, 'auto-pc');
    machineId = e.machineId;
    token = e.token;
  });
  afterEach(async () => {
    await srv.close();
  });

  const beat = (body: Record<string, unknown> = {}) => srv.request('POST', '/api/agent/heartbeat', { token, body: { agent_version: '0.14.0', ...body } });
  const machine = async () => (await srv.request('GET', '/api/machines', { cookie })).body.data.find((m: { id: string }) => m.id === machineId);

  it('übernimmt den gemeldeten Zustand bereinigt und zeigt ihn in der Maschine', async () => {
    await beat();
    expect((await machine()).autostart).toBeNull();
    await beat({ autostart: { enabled: true, method: 'systemd-Benutzerdienst', detail: 'Hinweis', evil: 'x' } });
    expect((await machine()).autostart).toEqual({ enabled: true, method: 'systemd-Benutzerdienst', detail: 'Hinweis' });
    await beat({ autostart: { enabled: 'ja', method: 5 } }); // ungültig → ignoriert
    expect((await machine()).autostart.enabled).toBe(true);
    expect((await machine()).agent_can_autostart).toBe(true);
  });

  it('reiht den Befehl ein, verlangt boolean und einen neuen Agent; das Ergebnis aktualisiert den Zustand sofort', async () => {
    await beat();
    const bad = await srv.request('POST', `/api/machines/${machineId}/autostart`, { cookie, body: { enabled: 'ja' } });
    expect(bad.status).toBe(400);
    const res = await srv.request('POST', `/api/machines/${machineId}/autostart`, { cookie, body: { enabled: true } });
    expect(res.status).toBe(202);
    const cmds = await srv.request('GET', '/api/agent/commands?wait=0', { token });
    expect(cmds.body.data[0]).toMatchObject({ action: 'agent.autostart', payload: { enabled: true } });
    await srv.request('POST', `/api/agent/commands/${cmds.body.data[0].id}/result`, { token, body: { status: 'done', data: { enabled: true, method: 'LaunchAgent', detail: null } } });
    expect((await machine()).autostart).toEqual({ enabled: true, method: 'LaunchAgent', detail: null });

    await beat({ agent_version: '0.13.0' });
    const old = await srv.request('POST', `/api/machines/${machineId}/autostart`, { cookie, body: { enabled: false } });
    expect(old.status).toBe(400);
  });
});
