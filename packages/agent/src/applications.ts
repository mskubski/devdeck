import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { MachineApplication } from '@devdeck/shared';

const exec = promisify(execFile);

async function out(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

const app = (name: unknown, version: unknown, publisher: unknown, identifier: unknown, source: string): MachineApplication | null => {
  const n = clean(name);
  return n ? { name: n, version: clean(version), publisher: clean(publisher), identifier: clean(identifier), source } : null;
};

const present = (a: MachineApplication | null): a is MachineApplication => a !== null;

/** Stabile Reihenfolge, Duplikate (gleicher Name + Version + Kennung) entfernen. */
export function normalizeApplications(list: MachineApplication[]): MachineApplication[] {
  const seen = new Set<string>();
  const result: MachineApplication[] = [];
  for (const a of list) {
    const key = `${a.name}\u0000${a.version ?? ''}\u0000${a.identifier ?? ''}\u0000${a.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(a);
  }
  return result.sort((x, y) => x.name.localeCompare(y.name, 'de', { sensitivity: 'base' }) || (x.version ?? '').localeCompare(y.version ?? ''));
}

// ───────────────────────────── Windows ─────────────────────────────

/**
 * Programme aus den Uninstall-Schlüsseln der Registry: MSI (auch ausgeblendete Komponenten wie .NET/VC++-Laufzeiten),
 * klassische Installer und Benutzerinstallationen; Updates (ParentKeyName) und ausgeblendete Nicht-MSI-Einträge entfallen.
 */
const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sources = @(
  @{ path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; user = $false },
  @{ path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; user = $false },
  @{ path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; user = $true }
)
$items = foreach ($s in $sources) {
  Get-ItemProperty $s.path | Where-Object { $_.DisplayName -and -not $_.ParentKeyName -and (-not $_.SystemComponent -or $_.WindowsInstaller -eq 1) } | ForEach-Object {
    $src = if ($_.WindowsInstaller -eq 1) { 'MSI' } elseif ($s.user) { 'Add or remove programs (user)' } else { 'Add or remove programs' }
    @{ name = [string]$_.DisplayName; version = [string]$_.DisplayVersion; publisher = [string]$_.Publisher; id = [string]$_.PSChildName; source = $src }
  }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 3
`;

interface WinApp {
  name?: string; version?: string; publisher?: string; id?: string; source?: string;
}

export function mapWindowsApps(raw: WinApp[] | WinApp | null): MachineApplication[] {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return normalizeApplications(list.map((a) => app(a.name, a.version, a.publisher, a.id, a.source ?? 'Add or remove programs')).filter(present));
}

async function windows(): Promise<MachineApplication[]> {
  const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
  const json = await out('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 120_000);
  return mapWindowsApps(JSON.parse(json) as WinApp[]);
}

// ───────────────────────────── Linux ─────────────────────────────

const stripEmail = (v: string): string | null => clean(v.replace(/\s*<[^>]*>/g, ''));

/** `dpkg-query -W -f '${Package}\t${Version}\t${Maintainer}\t${db:Status-Abbrev}\n'` */
export function parseDpkg(text: string): MachineApplication[] {
  return text.split('\n').flatMap((line) => {
    const [name, version, maintainer, status] = line.split('\t');
    if (!name || !status?.startsWith('ii')) return [];
    return [app(name, version, stripEmail(maintainer ?? ''), name, 'dpkg')].filter(present);
  });
}

/** `rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n'` */
export function parseRpm(text: string): MachineApplication[] {
  return text.split('\n').flatMap((line) => {
    const [name, version, vendor] = line.split('\t');
    return name ? [app(name, version, vendor === '(none)' ? null : vendor, name, 'rpm')].filter(present) : [];
  });
}

/** `pacman -Q`: „name version“ je Zeile. */
export function parsePacman(text: string): MachineApplication[] {
  return text.split('\n').flatMap((line) => {
    const [name, version] = line.trim().split(/\s+/);
    return name ? [app(name, version, null, name, 'pacman')].filter(present) : [];
  });
}

/** `snap list`: Kopfzeile, danach „Name Version Rev Tracking Publisher Notes“. */
export function parseSnap(text: string): MachineApplication[] {
  return text.split('\n').slice(1).flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) return [];
    return [app(parts[0], parts[1], parts[4]?.replace(/✓|\*+$/g, ''), parts[0], 'snap')].filter(present);
  });
}

/** `flatpak list --app --columns=application,name,version,origin` (tabulatorgetrennt). */
export function parseFlatpak(text: string): MachineApplication[] {
  return text.split('\n').flatMap((line) => {
    const [id, name, version, origin] = line.split('\t');
    return id ? [app(name || id, version, origin, id, 'flatpak')].filter(present) : [];
  });
}

async function linux(): Promise<MachineApplication[]> {
  const list: MachineApplication[] = [];
  const dpkg = await out('dpkg-query', ['-W', '-f', '${Package}\t${Version}\t${Maintainer}\t${db:Status-Abbrev}\n']);
  if (dpkg) list.push(...parseDpkg(dpkg));
  else {
    const rpm = await out('rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n']);
    if (rpm) list.push(...parseRpm(rpm));
    else {
      const pacman = await out('pacman', ['-Q']);
      if (pacman) list.push(...parsePacman(pacman));
    }
  }
  const snap = await out('snap', ['list'], 20_000);
  if (snap) list.push(...parseSnap(snap));
  const flatpak = await out('flatpak', ['list', '--app', '--columns=application,name,version,origin'], 20_000);
  if (flatpak) list.push(...parseFlatpak(flatpak));
  return normalizeApplications(list);
}

// ───────────────────────────── macOS ─────────────────────────────

const MAC_SOURCE: Record<string, string> = {
  apple: 'Apple', mac_app_store: 'Mac App Store', identified_developer: 'Identifizierter Entwickler', unknown: 'Unbekannt',
};

/** `system_profiler SPApplicationsDataType -json` → installierte Programme. */
export function parseMacApps(json: string): MachineApplication[] {
  try {
    const items = (JSON.parse(json) as { SPApplicationsDataType?: Array<Record<string, any>> }).SPApplicationsDataType ?? [];
    return items.map((i) => app(
      i._name, i.version, Array.isArray(i.signed_by) ? String(i.signed_by[0] ?? '').replace(/^(Developer ID Application|Apple Mac OS Application Signing):\s*/, '').replace(/\s*\([A-Z0-9]{10}\)$/, '') : null,
      i.path, MAC_SOURCE[String(i.obtained_from)] ?? 'Unbekannt',
    )).filter(present);
  } catch {
    return [];
  }
}

/** `brew list --versions`: „name version [version …]“. */
export function parseBrew(text: string): MachineApplication[] {
  return text.split('\n').flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    return parts[0] ? [app(parts[0], parts.slice(1).join(', '), null, parts[0], 'Homebrew')].filter(present) : [];
  });
}

async function mac(): Promise<MachineApplication[]> {
  const list = parseMacApps(await out('system_profiler', ['SPApplicationsDataType', '-json'], 180_000));
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p));
  if (brew) list.push(...parseBrew(await out(brew, ['list', '--versions'], 60_000)));
  return normalizeApplications(list);
}

/** Installierte Programme der Maschine; Fehler einzelner Quellen führen nur zu einer kürzeren Liste. */
export async function collectApplications(): Promise<MachineApplication[]> {
  try {
    if (process.platform === 'win32') return await windows();
    if (process.platform === 'darwin') return await mac();
    return await linux();
  } catch {
    return [];
  }
}
