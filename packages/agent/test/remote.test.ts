import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseVncHost, detectRemote, generateVncPassword, ownAddresses, preflightVnc, planInstall, probeVnc, softwareFromProcesses, windowsInstallArgs, x11vncUnit, type Runner } from '../src/remote.js';
import { openTunnel } from '../src/remoteTunnel.js';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

function listen(onConn: (s: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on("error", () => undefined); c.resume(); onConn(c); });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
  });
}

const vncServer = () => listen((c) => c.write('RFB 003.008\n'));
const noRunner: Runner = async () => ({ ok: false, stdout: '', stderr: '' });

describe('VNC-Erkennung (Agent)', () => {
  it('erkennt einen VNC-Server an der RFB-Begrüßung, andere Dienste und geschlossene Ports nicht', async () => {
    const vnc = await vncServer();
    const http = await listen((c) => c.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
    const silent = await listen(() => undefined);
    expect(await probeVnc(vnc)).toBe('RFB 003.008');
    expect(await probeVnc(http)).toBeNull();
    expect(await probeVnc(silent, '127.0.0.1', 300)).toBeNull();
    const closed = await listen(() => undefined);
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    expect(await probeVnc(closed)).toBeNull();
  });

  it('detectRemote meldet Port und Zustand; ohne VNC-Server „läuft nicht“', async () => {
    const port = await vncServer();
    const found = await detectRemote(noRunner, [port]);
    expect(found.vnc).toMatchObject({ running: true, port });
    expect(found.install.possible).toBe(false); // läuft schon
    const free = await listen(() => undefined);
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    const none = await detectRemote(noRunner, [free]);
    expect(none.vnc).toMatchObject({ running: false, port: null, software: null, local_only: null });
  });

  it('erkennt die VNC-Software an laufenden Prozessen', () => {
    expect(softwareFromProcesses(['bash', 'tvnserver.exe'])).toBe('TightVNC');
    expect(softwareFromProcesses(['x11vnc'])).toBe('x11vnc');
    expect(softwareFromProcesses(['Xtigervnc'])).toBe('TigerVNC');
    expect(softwareFromProcesses(['screensharingd'])).toBe('macOS Bildschirmfreigabe');
    expect(softwareFromProcesses(['node', 'bash'])).toBeNull();
  });
});

describe('VNC-Server, der localhost verweigert (TightVNC-Standard)', () => {
  /** Meldet sich mit RFB, verweigert aber Verbindungen von 127.0.0.1 wie TightVNC ohne „Loopback zulassen“. */
  const strict = (): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer((c) => {
        c.write('RFB 003.008\n');
        c.on('data', () => undefined);
        c.once('data', () => {
          const loop = c.remoteAddress === '127.0.0.1' || c.remoteAddress === '::ffff:127.0.0.1';
          if (loop) {
            const msg = Buffer.from('Sorry, loopback connections are not enabled');
            const head = Buffer.alloc(5);
            head.writeUInt32BE(0, 0);
            head[4] = 0;
            const len = Buffer.alloc(4);
            len.writeUInt32BE(msg.length, 0);
            c.write(Buffer.concat([Buffer.from([0]), len, msg]));
          } else c.write(Buffer.from([1, 2]));
        });
        c.on('error', () => undefined);
      });
      servers.push(s);
      s.listen(0, '0.0.0.0', () => resolve((s.address() as net.AddressInfo).port));
    });

  it('erkennt die Sperre und weicht auf die eigene Netzwerkadresse aus (falls vorhanden)', async () => {
    const port = await strict();
    expect(await preflightVnc('127.0.0.1', port)).toBe('blocked');
    const ok = await vncServer();
    expect(await preflightVnc('127.0.0.1', ok, 400)).toBe('ok'); // meldet sich, antwortet aber nicht: kein Hinweis auf eine Sperre
    const detected = await detectRemote(noRunner, [port]);
    expect(detected.vnc.loopback_blocked).toBe(true);
    const addrs = ownAddresses();
    if (addrs.length) expect(addrs).toContain(await chooseVncHost(port));
    else await expect(chooseVncHost(port)).rejects.toThrow(/verweigert/);
  });
});

describe('VNC einrichten: was ist möglich?', () => {
  const env = (o: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...o });
  const base = () => ({ session: 'x11' as string | null, package_manager: 'apt-get' as string | null, elevated: false, sudo: false as boolean | null, winget: null as boolean | null, x11vnc: false as boolean | null });

  it('Windows: nur mit winget und Administratorrechten', () => {
    expect(planInstall(env({ winget: true, elevated: true }), false, 'win32').possible).toBe(true);
    expect(planInstall(env({ winget: true, elevated: false }), false, 'win32')).toMatchObject({ possible: false, reason: expect.stringContaining('Administrator') });
    expect(planInstall(env({ winget: false, elevated: true }), false, 'win32').reason).toContain('winget');
  });

  it('Linux: X11 mit Paketrechten oder vorhandenem x11vnc; Wayland und Server ohne Desktop nicht', () => {
    expect(planInstall(env({ sudo: true }), false, 'linux').possible).toBe(true);
    expect(planInstall(env({ x11vnc: true }), false, 'linux').possible).toBe(true);
    expect(planInstall(env({}), false, 'linux')).toMatchObject({ possible: false, reason: expect.stringContaining('sudo') });
    expect(planInstall(env({ session: 'wayland', sudo: true }), false, 'linux').reason).toContain('Wayland');
    expect(planInstall(env({ session: null, sudo: true }), false, 'linux').reason).toContain('grafische Sitzung');
  });

  it('macOS: nie automatisch; läuft schon VNC: nichts zu tun', () => {
    expect(planInstall(env(), false, 'darwin').possible).toBe(false);
    expect(planInstall(env({ sudo: true }), true, 'linux').reason).toContain('läuft bereits');
  });

  it('erzeugt zufällige 8-stellige Passwörter und die Installationsbefehle ohne Shell-Verkettung', () => {
    const a = generateVncPassword();
    expect(a).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(generateVncPassword()).not.toBe(a);
    const args = windowsInstallArgs('Abcd2345', 'Zyxw9876');
    expect(args.slice(0, 4)).toEqual(['install', '-e', '--id', 'GlavSoft.TightVNC']);
    const override = args[args.indexOf('--override') + 1]!;
    expect(override).toContain('VALUE_OF_LOOPBACKONLY=1');
    expect(override).toContain('VALUE_OF_PASSWORD=Abcd2345');
    const unit = x11vncUnit(':0', '/home/u/.devdeck/vnc.pass', 5900);
    expect(unit).toContain('-localhost');
    expect(unit).toContain('-rfbauth /home/u/.devdeck/vnc.pass');
  });
});

describe('Tunnel (Agent)', () => {
  it('tunnelt nur zu VNC: falscher Port, kein VNC-Dienst und ungültige Sitzungsdaten werden abgelehnt', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const token = 'abcdefghijklmnopqrstuvwxyz012345';
    await expect(openTunnel({ serverUrl: 'http://127.0.0.1:1', sessionId, token, port: 22 })).rejects.toThrow(/kein VNC-Port/);
    const http = await listen((c) => c.write('SSH-2.0-OpenSSH\r\n'));
    await expect(openTunnel({ serverUrl: 'http://127.0.0.1:1', sessionId, token, port: http, portRange: [1, 65535] })).rejects.toThrow(/kein VNC-Server/);
    await expect(openTunnel({ serverUrl: 'http://127.0.0.1:1', sessionId: 'x', token, port: 5900 })).rejects.toThrow(/Ungültige Sitzungsdaten/);
    const vnc = await vncServer();
    await expect(openTunnel({ serverUrl: 'http://127.0.0.1:1', sessionId, token, port: vnc, portRange: [1, 65535] })).rejects.toThrow(/Tunnel zum DevDeck-Server/);
  });
});
