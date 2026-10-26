import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppError, type MachineAutostart } from '@devdeck/shared';

const exec = promisify(execFile);

/** Name des Autostart-Eintrags (Windows-Run-Wert, systemd-Unit, launchd-Label). */
const RUN_NAME = 'DevDeckAgent';
const UNIT_NAME = 'devdeck-agent.service';
const LAUNCHD_LABEL = 'de.devdeck.agent';
const WIN_RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Repo-Root der laufenden Agent-Installation (packages/agent/dist → Repo). */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export interface AutostartEnv {
  platform: NodeJS.Platform;
  home: string;
  root: string;
  node: string;
  /** Führt ein festes Programm mit festen Argumenten aus (keine Shell). */
  run: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
}

async function runReal(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(file, args, { timeout: 30_000, windowsHide: true });
    return { code: 0, stdout: String(stdout) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout ?? '') };
  }
}

export function realEnv(): AutostartEnv {
  return { platform: process.platform, home: os.homedir(), root: repoRoot(), node: process.execPath, run: runReal };
}

const entryOf = (env: AutostartEnv): string => path.join(env.root, 'packages', 'agent', 'dist', 'index.js');

/** Pfade landen in Skripten bzw. Konfigurationsdateien – Zeichen, die dort Befehle einschleusen könnten, werden abgelehnt. */
function assertSafePath(p: string): void {
  if (/['"`\r\n%$&|<>^]/.test(p)) {
    throw new AppError('VALIDATION', `Der Installationspfad enthält Sonderzeichen, die für den Autostart nicht erlaubt sind: ${p}`);
  }
}

// ---------- Linux (systemd-User-Dienst) ----------

export function buildSystemdUnit(root: string): string {
  return [
    '[Unit]', 'Description=DevDeck Agent', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${root}`,
    'ExecStart=/usr/bin/env node packages/agent/dist/index.js start',
    'Restart=on-failure', 'RestartSec=5', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

async function linuxState(env: AutostartEnv): Promise<MachineAutostart> {
  const r = await env.run('systemctl', ['--user', 'is-enabled', UNIT_NAME]);
  const enabled = r.code === 0 && r.stdout.trim() === 'enabled';
  let detail: string | null = null;
  if (enabled) {
    const linger = await env.run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger']);
    if (linger.stdout.trim() === 'Linger=no') detail = 'Startet beim Anmelden des Benutzers. Für Start ohne Anmeldung einmalig im Terminal: sudo loginctl enable-linger $USER';
  }
  return { enabled, method: 'systemd-Benutzerdienst', detail };
}

async function linuxSet(env: AutostartEnv, enabled: boolean): Promise<void> {
  const unit = path.join(process.env.XDG_CONFIG_HOME || path.join(env.home, '.config'), 'systemd', 'user', UNIT_NAME);
  if (enabled) {
    assertSafePath(env.root);
    if (!fs.existsSync(unit)) {
      fs.mkdirSync(path.dirname(unit), { recursive: true });
      fs.writeFileSync(unit, buildSystemdUnit(env.root));
      await env.run('systemctl', ['--user', 'daemon-reload']);
    }
    // Ohne --now: der laufende Agent bleibt der einzige Prozess, der Dienst greift ab dem nächsten Start
    const r = await env.run('systemctl', ['--user', 'enable', UNIT_NAME]);
    if (r.code !== 0) throw new AppError('INTERNAL', 'systemctl --user enable ist fehlgeschlagen (läuft eine Benutzer-Sitzung mit systemd?)');
  } else {
    await env.run('systemctl', ['--user', 'disable', UNIT_NAME]);
  }
}

// ---------- macOS (LaunchAgent) ----------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildLaunchdPlist(node: string, entry: string, root: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(entry)}</string><string>start</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`;
}

const plistPath = (env: AutostartEnv): string => path.join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

async function macState(env: AutostartEnv): Promise<MachineAutostart> {
  return { enabled: fs.existsSync(plistPath(env)), method: 'LaunchAgent', detail: null };
}

async function macSet(env: AutostartEnv, enabled: boolean): Promise<void> {
  const file = plistPath(env);
  if (enabled) {
    assertSafePath(env.root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Nur die Datei anlegen: geladen wird sie beim nächsten Anmelden (sonst liefe der Agent doppelt)
    fs.writeFileSync(file, buildLaunchdPlist(env.node, entryOf(env), env.root));
  } else {
    fs.rmSync(file, { force: true });
  }
}

// ---------- Windows (Run-Schlüssel des Benutzers, kein Administrator nötig) ----------

/** Befehl im Run-Schlüssel: startet den Agent ohne sichtbares Konsolenfenster. */
export function buildWindowsRunValue(node: string, entry: string, root: string): string {
  return `powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '${node}' -ArgumentList '${entry}','start' -WorkingDirectory '${root}'"`;
}

async function powershell(env: AutostartEnv, script: string): Promise<{ code: number; stdout: string }> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return env.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
}

async function windowsState(env: AutostartEnv): Promise<MachineAutostart> {
  const r = await powershell(env, `$v = (Get-ItemProperty -Path '${WIN_RUN_KEY}' -Name '${RUN_NAME}' -ErrorAction SilentlyContinue).${RUN_NAME}; if ($v) { 'enabled' } else { 'disabled' }`);
  return { enabled: r.stdout.trim() === 'enabled', method: 'Windows-Autostart (Anmeldung des Benutzers)', detail: null };
}

async function windowsSet(env: AutostartEnv, enabled: boolean): Promise<void> {
  let script: string;
  if (enabled) {
    for (const p of [env.node, entryOf(env), env.root]) assertSafePath(p);
    const value = buildWindowsRunValue(env.node, entryOf(env), env.root).replace(/'/g, "''");
    script = `Set-ItemProperty -Path '${WIN_RUN_KEY}' -Name '${RUN_NAME}' -Value '${value}'`;
  } else {
    script = `Remove-ItemProperty -Path '${WIN_RUN_KEY}' -Name '${RUN_NAME}' -ErrorAction SilentlyContinue`;
  }
  const r = await powershell(env, script);
  if (r.code !== 0) throw new AppError('INTERNAL', 'Der Autostart-Eintrag konnte in der Windows-Registrierung nicht geändert werden');
}

// ---------- Öffentliche API ----------

function unsupported(platform: string): never {
  throw new AppError('VALIDATION', `Autostart wird auf dieser Plattform nicht unterstützt (${platform})`);
}

export async function getAutostart(env: AutostartEnv = realEnv()): Promise<MachineAutostart> {
  if (env.platform === 'win32') return windowsState(env);
  if (env.platform === 'linux') return linuxState(env);
  if (env.platform === 'darwin') return macState(env);
  return unsupported(env.platform);
}

/** Autostart ein-/ausschalten und den neuen Zustand zurückgeben. */
export async function setAutostart(enabled: boolean, env: AutostartEnv = realEnv()): Promise<MachineAutostart> {
  if (env.platform === 'win32') await windowsSet(env, enabled);
  else if (env.platform === 'linux') await linuxSet(env, enabled);
  else if (env.platform === 'darwin') await macSet(env, enabled);
  else unsupported(env.platform);
  return getAutostart(env);
}
