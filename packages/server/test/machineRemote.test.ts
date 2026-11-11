import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { openTunnel } from '../../agent/src/remoteTunnel.js';

describe('Fernzugriff (VNC-Tunnel über den DevDeck-Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let machineId: string;
  let token: string;
  const closers: Array<() => void> = [];

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const e = await srv.enroll(cookie, 'remote-pc');
    machineId = e.machineId;
    token = e.token;
    await beat();
  });
  afterEach(async () => {
    for (const c of closers.splice(0)) c();
    await srv.close();
  });

  const beat = (body: Record<string, unknown> = {}) => srv.request('POST', '/api/agent/heartbeat', { token, body: { agent_version: '0.19.0', ...body } });
  const machine = async () => (await srv.request('GET', '/api/machines', { cookie })).body.data.find((m: { id: string }) => m.id === machineId);
  const remote = (over: object = {}) => ({
    checked_at: new Date().toISOString(),
    vnc: { running: true, port: 5900, software: 'TightVNC', local_only: true },
    install: { possible: false, method: null, reason: 'läuft bereits' },
    env: { session: null, package_manager: null, elevated: true, sudo: null, winget: true, x11vnc: null },
    ...over,
  });

  /** Ein „VNC-Server“, der sich mit RFB meldet und alles großgeschrieben zurückgibt. */
  const fakeVnc = (): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer((c) => {
        c.write('RFB 003.008\n');
        c.on('data', (d) => c.write(d.toString().toUpperCase()));
        c.on('error', () => undefined);
      });
      closers.push(() => s.close());
      s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
    });

  it('übernimmt den gemeldeten VNC-Zustand bereinigt', async () => {
    expect((await machine()).remote).toBeNull();
    await beat({ remote: { ...remote(), evil: 'x', vnc: { running: true, port: 5901, software: 'x11vnc', local_only: false, extra: 1 } } });
    const m = await machine();
    expect(m.remote.vnc).toEqual({ running: true, port: 5901, software: 'x11vnc', local_only: false });
    expect(m.agent_can_remote).toBe(true);
    expect(m.remote_password_set).toBe(false);
    await beat({ remote: { vnc: { running: 'ja' } } }); // ungültig → ignoriert
    expect((await machine()).remote.vnc.port).toBe(5901);
  });

  it('Installation: das Passwort landet im Vault und nie im Befehlsergebnis; die Sitzung liefert es dem Browser', async () => {
    const res = await srv.request('POST', `/api/machines/${machineId}/remote/install`, { cookie });
    expect(res.status).toBe(202);
    const cmds = await srv.request('GET', '/api/agent/commands?wait=0', { token });
    expect(cmds.body.data[0].action).toBe('remote.install');
    await srv.request('POST', `/api/agent/commands/${cmds.body.data[0].id}/result`, {
      token,
      body: { status: 'done', data: { password: 'Geheim12', port: 5900, detail: 'ok', remote: remote() } },
    });
    const m = await machine();
    expect(m.remote_password_set).toBe(true);
    expect(m.remote.vnc.running).toBe(true);
    const stored = srv.ctx.db.get<{ result_json: string }>('SELECT result_json FROM agent_commands WHERE id = ?', cmds.body.data[0].id)!;
    expect(stored.result_json).not.toContain('Geheim12');
    expect(JSON.stringify((await srv.request('GET', '/api/machines', { cookie })).body)).not.toContain('Geheim12');
    const session = await srv.request('POST', `/api/machines/${machineId}/remote/sessions`, { cookie, body: {} });
    expect(session.body.data.password).toBe('Geheim12');
  });

  it('Passwort lässt sich hinterlegen und entfernen; zu lange Werte werden abgelehnt', async () => {
    const set = await srv.request('PUT', `/api/machines/${machineId}/remote/password`, { cookie, body: { password: 'pw123456' } });
    expect(set.body.data.password_set).toBe(true);
    expect((await machine()).remote_password_set).toBe(true);
    expect((await srv.request('PUT', `/api/machines/${machineId}/remote/password`, { cookie, body: { password: 'x'.repeat(65) } })).status).toBe(400);
    expect((await srv.request('PUT', `/api/machines/${machineId}/remote/password`, { cookie, body: { password: null } })).body.data.password_set).toBe(false);
    expect((await machine()).remote_password_set).toBe(false);
  });

  it('Sitzung: Browser ⇄ Server ⇄ Agent-Tunnel ⇄ VNC-Server; Audit-Log ohne Daten; nur der Besitzer', async () => {
    const vncPort = await fakeVnc();
    const created = await srv.request('POST', `/api/machines/${machineId}/remote/sessions`, { cookie, body: {} });
    expect(created.status).toBe(201);
    const { session_id: sessionId, ws_path: wsPath } = created.body.data;

    // der Agent holt den Befehl und öffnet den Tunnel (im Test zu einem Port außerhalb 5900–5999)
    const cmds = await srv.request('GET', '/api/agent/commands?wait=0', { token });
    const open = cmds.body.data.find((c: { action: string }) => c.action === 'remote.open');
    expect(open.payload).toMatchObject({ session_id: sessionId, port: 5900 });

    // falscher Token wird abgelehnt
    await expect(openTunnel({ serverUrl: srv.base, sessionId, token: 'x'.repeat(32), port: vncPort, portRange: [1, 65535] })).rejects.toThrow(/Tunnel zum DevDeck-Server/);
    const tunnel = await openTunnel({ serverUrl: srv.base, sessionId, token: open.payload.token, port: vncPort, portRange: [1, 65535] });
    closers.push(() => tunnel.close());

    // fremde Herkunft (Origin) und fehlende Anmeldung werden abgelehnt
    const wsUrl = srv.base.replace('http', 'ws') + wsPath;
    const attempt = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(wsUrl, ['binary'], { headers });
        ws.on('open', () => { ws.close(); resolve('open'); });
        ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
        ws.on('error', () => resolve('error'));
      });
    expect(await attempt({ Cookie: cookie, Origin: 'https://evil.example' })).toBe('403');
    expect(await attempt({})).toBe('401');

    const ws = new WebSocket(wsUrl, ['binary'], { headers: { Cookie: cookie, Origin: srv.base } });
    const got: string[] = [];
    ws.on('message', (d) => got.push(d.toString()));
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    await waitFor(() => got.join('').includes('RFB 003.008'));
    ws.send(Buffer.from('hallo vnc'));
    await waitFor(() => got.join('').includes('HALLO VNC'));

    // zweiter Browser auf dieselbe Sitzung: abgelehnt
    expect(await attempt({ Cookie: cookie, Origin: srv.base })).toBe('401');

    ws.close();
    await waitFor(() => srv.ctx.db.get('SELECT 1 AS x FROM audit_log WHERE action = ?', 'machine.remote.end') !== undefined);
    const logs = srv.ctx.db.all<{ action: string; detail_json: string }>(`SELECT action, detail_json FROM audit_log WHERE action LIKE 'machine.remote.%'`);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['machine.remote.start', 'machine.remote.end']));
    expect(JSON.stringify(logs)).not.toContain('HALLO');
  });

  it('Voraussetzungen: Agent online und neu genug, Port im VNC-Bereich, nur Besitzer/Admin', async () => {
    const bad = await srv.request('POST', `/api/machines/${machineId}/remote/sessions`, { cookie, body: { port: 22 } });
    expect(bad.status).toBe(400);
    await beat({ agent_version: '0.18.1' });
    const old = await srv.request('POST', `/api/machines/${machineId}/remote/sessions`, { cookie, body: {} });
    expect(old.status).toBe(400);
    expect(old.body.error.message).toContain('0.19.0');
    expect((await srv.request('POST', `/api/machines/${machineId}/remote/sessions`, { body: {} })).status).toBe(401);
    srv.ctx.db.run(`UPDATE machines SET agent_status='offline' WHERE id=?`, machineId);
    await beat({ agent_version: '0.19.0' });
    srv.ctx.db.run(`UPDATE machines SET agent_status='offline' WHERE id=?`, machineId);
    expect((await srv.request('POST', `/api/machines/${machineId}/remote/detect`, { cookie })).status).toBe(503);
  });
});

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung im Test');
    await new Promise((r) => setTimeout(r, 25));
  }
}
