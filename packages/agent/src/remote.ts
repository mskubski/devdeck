import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { AppError, type MachineRemote } from '@devdeck/shared';

/**
 * Fernzugriff per VNC: erkennt, ob auf der Maschine ein VNC-Server läuft, und richtet bei Bedarf einen ein.
 * DevDeck tunnelt später nur zu VNC-Servern auf der eigenen Maschine (127.0.0.1, Ports 5900–5999) – nie zu beliebigen Diensten.
 */

export const VNC_PORTS = [5900, 5901, 5902, 5903];
export const VNC_PORT_MIN = 5900;
export const VNC_PORT_MAX = 5999;
const BANNER = /^RFB \d{3}\.\d{3}\n/;

export type Runner = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Externes Programm ohne Shell ausführen; Fehler liefern ok=false statt zu werfen. */
export const run: Runner = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs ?? 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** Spricht auf host:port ein VNC-Server? Liefert die Begrüßung („RFB 003.008“) oder null. */
export function probeVnc(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (banner: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(banner);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('data', (buf) => {
      const text = buf.toString('latin1', 0, 12);
      finish(BANNER.test(text) ? text.trim() : null);
    });
    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
  });
}

/** Ist der VNC-Port auch über eine Netzwerkadresse der Maschine erreichbar? true = ja (Warnung), false = nur lokal, null = unbekannt. */
export async function exposedToNetwork(port: number): Promise<boolean | null> {
  const addrs: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
  }
  if (!addrs.length) return null;
  for (const a of addrs.slice(0, 6)) {
    if (await probeVnc(port, a, 1200)) return true;
  }
  return false;
}

const SOFTWARE: Array<[RegExp, string]> = [
  [/^tvnserver/i, 'TightVNC'],
  [/^winvnc/i, 'UltraVNC / RealVNC'],
  [/^vncserver/i, 'RealVNC'],
  [/^x11vnc$/i, 'x11vnc'],
  [/^(xtigervnc|Xvnc)$/i, 'TigerVNC'],
  [/^xtightvnc$/i, 'TightVNC'],
  [/^vino-server$/i, 'Vino'],
  [/^gnome-remote-desktop/i, 'GNOME Remote Desktop'],
  [/^krfb/i, 'KRFB'],
  [/^wayvnc$/i, 'wayvnc'],
  [/^(screensharingd|ARDAgent)$/i, 'macOS Bildschirmfreigabe'],
];

export function softwareFromProcesses(names: string[]): string | null {
  for (const n of names) for (const [re, label] of SOFTWARE) if (re.test(n.trim())) return label;
  return null;
}

async function processNames(exec: Runner): Promise<string[]> {
  if (process.platform === 'win32') {
    const r = await exec('tasklist', ['/FO', 'CSV', '/NH']);
    return r.stdout.split(/\r?\n/).map((l) => l.split('","')[0]?.replace(/^"/, '') ?? '').filter(Boolean);
  }
  const r = await exec('ps', ['-eo', 'comm=']);
  return r.stdout.split(/\r?\n/).map((l) => path.basename(l.trim())).filter(Boolean);
}

function which(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return dirs.some((d) => d && exts.some((e) => fs.existsSync(path.join(d, name + e))));
}

function linuxSession(): string | null {
  const t = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (t === 'x11' || t === 'wayland' || t === 'tty') return t;
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  try {
    if (fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f))) return 'x11';
  } catch {
    /* kein X-Socket */
  }
  try {
    for (const uid of fs.readdirSync('/run/user')) {
      if (fs.existsSync(path.join('/run/user', uid, 'wayland-0'))) return 'wayland';
    }
  } catch {
    /* kein Wayland */
  }
  return null;
}

function packageManager(): string | null {
  for (const pm of ['apt-get', 'dnf', 'yum', 'pacman', 'zypper']) if (which(pm)) return pm;
  return null;
}

/** Die Umgebung der Maschine: was bestimmt, ob und wie VNC eingerichtet werden kann. */
export async function inspectEnv(exec: Runner = run): Promise<MachineRemote['env']> {
  if (process.platform === 'win32') {
    const sess = await exec('net', ['session']); // gelingt nur mit Administratorrechten
    const winget = await exec('winget', ['--version']);
    return { session: null, package_manager: null, elevated: sess.ok, sudo: null, winget: winget.ok, x11vnc: null };
  }
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const sudo = root ? true : (await exec('sudo', ['-n', 'true'])).ok;
  if (process.platform === 'darwin') return { session: null, package_manager: null, elevated: root, sudo, winget: null, x11vnc: null };
  return { session: linuxSession(), package_manager: packageManager(), elevated: root, sudo, winget: null, x11vnc: which('x11vnc') };
}

/** Was kann DevDeck hier selbst einrichten? (reine Entscheidung aus Umgebung und Zustand) */
export function planInstall(env: MachineRemote['env'], running: boolean, platform: string = process.platform): MachineRemote['install'] {
  if (running) return { possible: false, method: null, reason: 'Ein VNC-Server läuft bereits.' };
  if (platform === 'win32') {
    if (!env.winget) return { possible: false, method: null, reason: 'winget ist nicht verfügbar – TightVNC bitte manuell installieren (siehe Befehl unten).' };
    if (!env.elevated) return { possible: false, method: null, reason: 'Der Agent läuft ohne Administratorrechte. Starte ihn als Administrator oder führe den Befehl unten in einer Administrator-PowerShell aus.' };
    return { possible: true, method: 'TightVNC (winget), nur lokal erreichbar, als Dienst', reason: null };
  }
  if (platform === 'darwin') {
    return { possible: false, method: null, reason: 'Auf dem Mac gibt es die eingebaute Bildschirmfreigabe – bitte in den Systemeinstellungen einschalten (siehe unten).' };
  }
  if (env.session === 'wayland') {
    return { possible: false, method: null, reason: 'Wayland-Sitzung: x11vnc funktioniert hier nicht. Nutze die GNOME-Bildschirmfreigabe (siehe Befehl unten) oder melde dich mit einer X11-Sitzung an.' };
  }
  if (env.session === null || env.session === 'tty') {
    return { possible: false, method: null, reason: 'Keine grafische Sitzung gefunden (Server ohne Desktop?). Für einen virtuellen Desktop siehe TigerVNC unten.' };
  }
  if (!env.x11vnc && !(env.package_manager && (env.elevated || env.sudo))) {
    return { possible: false, method: null, reason: 'x11vnc fehlt und der Agent darf keine Pakete installieren (kein Root, kein sudo ohne Passwort). Bitte den Befehl unten ausführen.' };
  }
  return { possible: true, method: 'x11vnc als systemd-Benutzerdienst, nur lokal erreichbar', reason: null };
}

/** Vollständige Erkennung für Heartbeat und `remote.detect`. */
export async function detectRemote(exec: Runner = run, ports: number[] = VNC_PORTS): Promise<MachineRemote> {
  let port: number | null = null;
  for (const p of ports) {
    if (await probeVnc(p)) {
      port = p;
      break;
    }
  }
  const env = await inspectEnv(exec);
  let software: string | null = null;
  let localOnly: boolean | null = null;
  if (port !== null) {
    software = softwareFromProcesses(await processNames(exec));
    const exposed = await exposedToNetwork(port);
    localOnly = exposed === null ? null : !exposed;
  }
  return {
    checked_at: new Date().toISOString(),
    vnc: { running: port !== null, port, software, local_only: localOnly },
    install: planInstall(env, port !== null),
    env,
  };
}

/** 8 Zeichen: VNC-Authentifizierung wertet ohnehin nur die ersten 8 aus. Ohne leicht verwechselbare Zeichen. */
export function generateVncPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function windowsInstallArgs(password: string, controlPassword: string): string[] {
  const props = [
    '/qn', '/norestart', 'ADDLOCAL=Server',
    'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=1',
    'SET_PASSWORD=1', `VALUE_OF_PASSWORD=${password}`,
    'SET_USECONTROLAUTHENTICATION=1', 'VALUE_OF_USECONTROLAUTHENTICATION=1',
    'SET_CONTROLPASSWORD=1', `VALUE_OF_CONTROLPASSWORD=${controlPassword}`,
    'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1',
    'SET_LOOPBACKONLY=1', 'VALUE_OF_LOOPBACKONLY=1',
  ];
  return ['install', '-e', '--id', 'GlavSoft.TightVNC', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--override', props.join(' ')];
}

export function x11vncUnit(display: string, passFile: string, port: number): string {
  return [
    '[Unit]',
    'Description=DevDeck Fernzugriff (x11vnc, nur lokal)',
    'After=graphical-session.target',
    '',
    '[Service]',
    `ExecStart=/usr/bin/env x11vnc -display ${display} -auth guess -rfbauth ${passFile} -rfbport ${port} -localhost -forever -shared -noxdamage -repeat`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface InstallOutcome {
  password: string;
  port: number;
  detail: string;
}

async function waitForVnc(port: number, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i += 1) {
    if (await probeVnc(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Richtet – wenn die Umgebung es zulässt – einen nur lokal erreichbaren VNC-Server mit zufälligem Passwort ein. */
export async function installVnc(exec: Runner = run, plan?: { env: MachineRemote['env']; install: MachineRemote['install'] }): Promise<InstallOutcome> {
  const env = plan?.env ?? (await inspectEnv(exec));
  const running = (await probeVnc(5900)) !== null;
  const install = plan?.install ?? planInstall(env, running);
  if (!install.possible) throw new AppError('VALIDATION', install.reason ?? 'VNC kann hier nicht automatisch eingerichtet werden.');
  const password = generateVncPassword();

  if (process.platform === 'win32') {
    const r = await exec('winget', windowsInstallArgs(password, generateVncPassword()), { timeoutMs: 10 * 60_000 });
    if (!r.ok) throw new AppError('INTERNAL', `winget-Installation fehlgeschlagen: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    if (!(await waitForVnc(5900, 30))) throw new AppError('INTERNAL', 'TightVNC wurde installiert, antwortet aber noch nicht auf Port 5900 (Dienst „TightVNC Server“ prüfen).');
    return { password, port: 5900, detail: 'TightVNC installiert (Dienst, nur lokal erreichbar)' };
  }

  // Linux: x11vnc (falls nötig per Paketverwaltung) + systemd-Benutzerdienst
  if (!env.x11vnc) {
    const pm = env.package_manager!;
    const sudo = env.elevated ? [] : ['sudo', '-n'];
    const cmd =
      pm === 'apt-get' ? ['apt-get', 'install', '-y', 'x11vnc']
      : pm === 'pacman' ? ['pacman', '-S', '--noconfirm', 'x11vnc']
      : pm === 'zypper' ? ['zypper', '--non-interactive', 'install', 'x11vnc']
      : [pm, 'install', '-y', 'x11vnc'];
    const full = [...sudo, ...cmd];
    const r = await exec(full[0]!, full.slice(1), { timeoutMs: 10 * 60_000 });
    if (!r.ok) throw new AppError('INTERNAL', `Paketinstallation fehlgeschlagen: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  }
  const dir = path.join(os.homedir(), '.devdeck');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const passFile = path.join(dir, 'vnc.pass');
  const stored = await exec('x11vnc', ['-storepasswd', password, passFile]);
  if (!stored.ok) throw new AppError('INTERNAL', `VNC-Passwort konnte nicht abgelegt werden: ${stored.stderr.trim().slice(-200)}`);
  fs.chmodSync(passFile, 0o600);
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'devdeck-vnc.service'), x11vncUnit(process.env.DISPLAY || ':0', passFile, 5900));
  await exec('systemctl', ['--user', 'daemon-reload']);
  const en = await exec('systemctl', ['--user', 'enable', '--now', 'devdeck-vnc.service']);
  if (!en.ok) throw new AppError('INTERNAL', `Dienst konnte nicht gestartet werden: ${(en.stderr || en.stdout).trim().slice(-300)}`);
  if (!(await waitForVnc(5900, 15))) throw new AppError('INTERNAL', 'Der Dienst läuft, x11vnc antwortet aber nicht (läuft eine X11-Sitzung auf :0? Siehe „journalctl --user -u devdeck-vnc“).');
  return { password, port: 5900, detail: 'x11vnc als systemd-Benutzerdienst „devdeck-vnc“ eingerichtet (nur lokal erreichbar)' };
}
