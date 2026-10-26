import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { MachinePatchItem, MachinePatches, MachineInstalledUpdate, PatchStatus } from '@devdeck/shared';

const exec = promisify(execFile);

async function out(cmd: string, args: string[], timeout = 60_000, env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, {
      timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout;
  } catch (err) {
    // dnf check-update beendet sich mit 100, wenn Updates vorliegen – die Ausgabe ist trotzdem gültig
    const e = err as { stdout?: string };
    return typeof e.stdout === 'string' ? e.stdout : '';
  }
}

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' || t === '-' ? null : t;
};

const item = (
  vendor: unknown, name: unknown, version: unknown, available: unknown, status: PatchStatus, kind: 'os' | 'app', detail?: unknown, id?: unknown,
): MachinePatchItem | null => {
  const n = clean(name);
  return n ? { vendor: clean(vendor), name: n, version: clean(version), available: clean(available), status, kind, detail: clean(detail), id: clean(id) } : null;
};
const present = (i: MachinePatchItem | null): i is MachinePatchItem => i !== null;

/** Kritisch zuerst, dann Sicherheit, dann übrige; innerhalb nach Name. */
const RANK: Record<PatchStatus, number> = { critical: 0, security: 1, update: 2 };
export function sortPatchItems(items: MachinePatchItem[]): MachinePatchItem[] {
  return items.slice().sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
}

// ───────────────────────────── Windows ─────────────────────────────

/** Ausstehende Windows-Updates (Windows Update Agent), zuletzt installierte Updates und Neustart-Hinweise. */
const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$result = @{ updates = @(); hotfixes = @(); rebootRequired = $false; searchError = $null }
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  $result.updates = @($found.Updates | ForEach-Object {
    @{ id = [string]$_.Identity.UpdateID; title = [string]$_.Title; kb = @($_.KBArticleIDs); severity = [string]$_.MsrcSeverity; categories = @($_.Categories | ForEach-Object { $_.Name }) }
  })
} catch { $result.searchError = $_.Exception.Message }
$result.hotfixes = @(Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 30 | ForEach-Object {
  @{ id = $_.HotFixID; description = $_.Description; installedOn = $(if ($_.InstalledOn) { $_.InstalledOn.ToString('yyyy-MM-dd') } else { $null }) }
})
$result.rebootRequired = [bool]((Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'))
ConvertTo-Json -InputObject $result -Compress -Depth 5
`;

interface WinUpdates {
  updates?: Array<{ id?: string; title?: string; kb?: string[] | string; severity?: string; categories?: string[] | string }> | { id?: string; title?: string; kb?: string[] | string; severity?: string; categories?: string[] | string };
  hotfixes?: Array<{ id?: string; description?: string; installedOn?: string | null }> | { id?: string; description?: string; installedOn?: string | null };
  rebootRequired?: boolean;
  searchError?: string | null;
}

const arr = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function mapWindowsUpdates(raw: WinUpdates): { items: MachinePatchItem[]; installed: MachineInstalledUpdate[]; reboot: boolean; error: string | null } {
  const items = arr(raw.updates).map((u) => {
    const sev = (u.severity ?? '').toLowerCase();
    const cats = arr(u.categories).join(', ');
    const status: PatchStatus = sev === 'critical' ? 'critical' : sev === 'important' || /security updates|sicherheitsupdates/i.test(cats) ? 'security' : 'update';
    const kb = arr(u.kb).map((k) => `KB${k}`).join(', ');
    return item('Microsoft', u.title, null, kb || null, status, 'os', cats || null, u.id);
  }).filter(present);
  const installed = arr(raw.hotfixes).flatMap((h) => (h.id ? [{ id: h.id, description: clean(h.description), installed_on: clean(h.installedOn) }] : []));
  return { items, installed, reboot: Boolean(raw.rebootRequired), error: clean(raw.searchError) };
}

/** `winget upgrade`: Tabelle mit Kopfzeile und Strichen; Spalten werden an den Positionen der Kopfzeile geschnitten (sprachunabhängig). */
export function parseWingetUpgrade(text: string): MachinePatchItem[] {
  const lines = text.split(/\r?\n/);
  const sep = lines.findIndex((l) => /^-{5,}\s*$/.test(l.trim()));
  if (sep < 1) return [];
  const header = lines[sep - 1]!;
  const starts = [...header.matchAll(/\S+(?: \S+)*/g)].map((m) => m.index!);
  if (starts.length < 4) return [];
  const cut = (line: string, i: number): string => line.slice(starts[i], starts[i + 1] ?? undefined).trim();
  const result: MachinePatchItem[] = [];
  for (const line of lines.slice(sep + 1)) {
    if (!line.trim()) break; // Tabellenende
    const id = cut(line, 1);
    if (!id || /\s/.test(id)) continue; // Fußzeile („n Aktualisierungen verfügbar“)
    result.push(item(id.split('.')[0], cut(line, 0), cut(line, 2), cut(line, 3), 'update', 'app', id, id)!);
  }
  return result.filter(present);
}

async function windows(p: Partial<MachinePatches> & { notes: string[]; items: MachinePatchItem[] }): Promise<void> {
  const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
  const json = await out('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 240_000);
  const w = mapWindowsUpdates(JSON.parse(json) as WinUpdates);
  p.items.push(...w.items);
  p.installed = w.installed;
  p.reboot_required = w.reboot;
  p.last_installed_at = w.installed.map((i) => i.installed_on).filter((d): d is string => Boolean(d)).sort().pop() ?? null;
  if (w.error) p.notes.push(`Windows Update konnte nicht abgefragt werden: ${w.error.slice(0, 200)}`);
  const winget = await out('winget', ['upgrade', '--accept-source-agreements', '--disable-interactivity'], 120_000);
  if (winget) p.items.push(...parseWingetUpgrade(winget));
  else p.notes.push('Anwendungs-Updates (winget) nicht verfügbar – nur Windows-Updates geprüft.');
  p.scanner = 'Windows Update Agent, winget';
}

// ───────────────────────────── Linux ─────────────────────────────

/** `apt list --upgradable`: „name/suite version arch [upgradable from: alt]“. */
export function parseApt(text: string): MachinePatchItem[] {
  return text.split('\n').flatMap((line) => {
    const m = /^([^/\s]+)\/(\S+) (\S+) \S+ \[upgradable from: ([^\]]+)\]/.exec(line.trim());
    if (!m) return [];
    return [item(null, m[1], m[4], m[3], /security/i.test(m[2]!) ? 'security' : 'update', 'os', m[2], m[1])].filter(present);
  });
}

/** `dnf -q check-update`: „name.arch version repo“, optional gefolgt von „Obsoleting Packages“. */
export function parseDnfCheckUpdate(text: string, security: Map<string, PatchStatus> = new Map()): MachinePatchItem[] {
  const result: MachinePatchItem[] = [];
  for (const line of text.split('\n')) {
    if (/^Obsoleting Packages/i.test(line)) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || !/\d/.test(parts[1]!)) continue;
    const name = parts[0]!.replace(/\.[^.]+$/, '');
    result.push(...[item(null, name, null, parts[1], security.get(name) ?? 'update', 'os', parts[2], name)].filter(present));
  }
  return result;
}

/** `dnf -q updateinfo list --security`: „ADVISORY Severity/Sec. paket-version-release.arch“. */
export function parseDnfSecurity(text: string): Map<string, PatchStatus> {
  const map = new Map<string, PatchStatus>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || !/Sec\./i.test(parts[1]!)) continue;
    const name = /^(.+)-[^-]+-[^-]+\.[^.]+$/.exec(parts[2]!)?.[1];
    if (name) map.set(name, /^Critical/i.test(parts[1]!) ? 'critical' : 'security');
  }
  return map;
}

/** `checkupdates` (pacman-contrib): „name alt -> neu“. */
export function parseCheckupdates(text: string): MachinePatchItem[] {
  return text.split('\n').flatMap((line) => {
    const m = /^(\S+) (\S+) -> (\S+)/.exec(line.trim());
    return m ? [item(null, m[1], m[2], m[3], 'update', 'os', null, m[1])].filter(present) : [];
  });
}

async function linux(p: Partial<MachinePatches> & { notes: string[]; items: MachinePatchItem[] }): Promise<void> {
  const env = { LC_ALL: 'C' };
  p.reboot_required = fs.existsSync('/var/run/reboot-required');
  const apt = await out('apt', ['list', '--upgradable'], 60_000, env);
  if (apt) {
    p.items.push(...parseApt(apt));
    p.scanner = 'apt';
    for (const stamp of ['/var/lib/apt/periodic/update-success-stamp', '/var/cache/apt/pkgcache.bin']) {
      try {
        const t = fs.statSync(stamp).mtime;
        p.notes.push(`Paketliste zuletzt aktualisiert: ${t.toISOString()} (apt prüft nicht selbst, ob es neuere Pakete gibt – das Ergebnis ist so aktuell wie diese Liste).`);
        break;
      } catch {
        /* nächste Datei */
      }
    }
  } else {
    const dnf = await out('dnf', ['-q', 'check-update'], 180_000, env);
    if (dnf) {
      const sec = parseDnfSecurity(await out('dnf', ['-q', 'updateinfo', 'list', '--security'], 120_000, env));
      p.items.push(...parseDnfCheckUpdate(dnf, sec));
      p.scanner = 'dnf';
    } else {
      const pac = await out('checkupdates', [], 120_000, env);
      if (pac) {
        p.items.push(...parseCheckupdates(pac));
        p.scanner = 'pacman (checkupdates)';
      } else if (!(await out('apt', ['--version'], 5_000, env)) && !(await out('dnf', ['--version'], 5_000, env))) {
        p.notes.push('Kein unterstützter Paketmanager gefunden (apt, dnf, checkupdates).');
      }
    }
  }
  // zuletzt installierte Pakete aus dem dpkg-Protokoll (nur Datum + Paket), falls lesbar
  try {
    const log = fs.readFileSync('/var/log/dpkg.log', 'utf8').split('\n').filter((l) => / (install|upgrade) /.test(l)).slice(-30).reverse();
    p.installed = log.flatMap((l) => {
      const m = /^(\d{4}-\d{2}-\d{2}) \S+ (install|upgrade) (\S+) (?:\S+ )?(\S+)/.exec(l);
      return m ? [{ id: m[3]!.split(':')[0]!, description: `${m[2] === 'upgrade' ? 'Aktualisiert' : 'Installiert'} (${m[4]})`, installed_on: m[1]! }] : [];
    });
    p.last_installed_at = p.installed[0]?.installed_on ?? null;
  } catch {
    /* kein Protokoll */
  }
}

// ───────────────────────────── macOS ─────────────────────────────

/** `softwareupdate -l`: Blöcke aus „* Label: …“ und einer Detailzeile („Title: …, Version: …, Recommended: YES“). */
export function parseSoftwareUpdate(text: string): MachinePatchItem[] {
  const lines = text.split('\n');
  const result: MachinePatchItem[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const label = /^\s*\*\s*(?:Label:\s*)?(.+)$/.exec(lines[i]!)?.[1]?.trim();
    if (!label) continue;
    const details = lines[i + 1] ?? '';
    const title = /Title:\s*([^,]+)/.exec(details)?.[1]?.trim() ?? label;
    const version = /Version:\s*([^,\s]+)/.exec(details)?.[1] ?? null;
    const security = /sicherheit|security/i.test(`${title} ${label}`);
    const restart = /Action:\s*restart/i.test(details);
    result.push(item('Apple', title, null, version, security ? 'security' : 'update', 'os', restart ? `${label} (Neustart nötig)` : label, label)!);
  }
  return result.filter(present);
}

/** `brew outdated --verbose`: „name (alt[, alt]) < neu“. */
export function parseBrewOutdated(text: string): MachinePatchItem[] {
  return text.split('\n').flatMap((line) => {
    const m = /^(\S+) \(([^)]+)\) [<!=]+ (\S+)/.exec(line.trim());
    return m ? [item(null, m[1], m[2], m[3], 'update', 'app', 'Homebrew', m[1])].filter(present) : [];
  });
}

async function mac(p: Partial<MachinePatches> & { notes: string[]; items: MachinePatchItem[] }): Promise<void> {
  const su = await out('softwareupdate', ['-l'], 240_000);
  p.items.push(...parseSoftwareUpdate(su));
  p.reboot_required = null;
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((b) => fs.existsSync(b));
  if (brew) p.items.push(...parseBrewOutdated(await out(brew, ['outdated', '--verbose'], 120_000)));
  p.scanner = brew ? 'softwareupdate, Homebrew' : 'softwareupdate';
  if (!su.trim()) p.notes.push('softwareupdate lieferte keine Ausgabe (kein Netz oder keine Berechtigung).');
}

/**
 * Patch-Stand der Maschine: ausstehende Betriebssystem-Updates und – soweit der Paketmanager es hergibt – veraltete Programme.
 * Gelistet wird nur, was ein Update braucht; ein Hersteller-Scanner mit „Up-to-date“-Status je Produkt ist das nicht.
 */
export async function collectPatches(): Promise<MachinePatches> {
  const p: Partial<MachinePatches> & { notes: string[]; items: MachinePatchItem[] } = {
    scanner: 'unbekannt', items: [], installed: [], notes: [], reboot_required: null, last_installed_at: null,
  };
  try {
    if (process.platform === 'win32') await windows(p);
    else if (process.platform === 'darwin') await mac(p);
    else await linux(p);
  } catch (err) {
    p.notes.push(`Patch-Prüfung unvollständig: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  const items = sortPatchItems(p.items);
  return {
    collected_at: new Date().toISOString(),
    scanner: p.scanner ?? 'unbekannt',
    total: items.length,
    critical: items.filter((i) => i.status === 'critical').length,
    security: items.filter((i) => i.status === 'critical' || i.status === 'security').length,
    reboot_required: p.reboot_required ?? null,
    last_installed_at: p.last_installed_at ?? null,
    items: items.slice(0, 500),
    installed: (p.installed ?? []).slice(0, 30),
    notes: p.notes,
  };
}
