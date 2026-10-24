import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MachineLogEntry, MachineLogLevel } from '@devdeck/shared';

const exec = promisify(execFile);

/** Mehr als so viele neue Einträge je Durchlauf werden nicht übertragen (die neuesten gewinnen). */
export const MAX_LOG_ENTRIES = 300;

interface Run {
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], timeout = 90_000): Promise<Run> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: typeof e.stdout === 'string' ? e.stdout : '', stderr: typeof e.stderr === 'string' ? e.stderr : '' };
  }
}

/** Erste nichtleere Zeile(n) einer Meldung, auf eine vernünftige Länge gekürzt. */
const oneLine = (v: unknown, max = 500): string => {
  const t = String(v ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ⏎ ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const clean = (v: unknown): string | null => {
  const t = v === null || v === undefined ? '' : String(v).trim();
  return t === '' ? null : t;
};

const iso = (v: unknown): string | null => {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Neueste zuerst, Duplikate entfernen, begrenzen. */
export function finalizeLogs(entries: MachineLogEntry[], max = MAX_LOG_ENTRIES): MachineLogEntry[] {
  const seen = new Set<string>();
  const result: MachineLogEntry[] = [];
  for (const e of entries.slice().sort((a, b) => b.time.localeCompare(a.time))) {
    const key = `${e.time}|${e.source}|${e.provider ?? ''}|${e.event_id ?? ''}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(e);
    if (result.length >= max) break;
  }
  return result;
}

// ───────────────────────────── Windows ─────────────────────────────

/**
 * Ereignisprotokolle System und Anwendung (Stufe Kritisch/Fehler). Hardwarefehler stehen im System-Protokoll
 * (Anbieter z. B. disk, Ntfs, WHEA-Logger). Das Sicherheitsprotokoll braucht Administratorrechte und wird nicht gelesen.
 */
const winScript = (since: string): string => `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$start = [DateTime]::Parse('${since}', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
$events = Get-WinEvent -FilterHashtable @{ LogName = @('System', 'Application'); Level = @(1, 2); StartTime = $start } -MaxEvents ${MAX_LOG_ENTRIES * 2}
ConvertTo-Json -InputObject @($events | ForEach-Object {
  @{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); log = [string]$_.LogName; provider = [string]$_.ProviderName; id = [string]$_.Id; level = [int]$_.Level; message = [string]$_.Message }
}) -Compress -Depth 3
`;

interface WinEvent {
  time?: string; log?: string; provider?: string; id?: string; level?: number; message?: string;
}

export function mapWindowsEvents(raw: WinEvent[] | WinEvent | null): MachineLogEntry[] {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return list.flatMap((e) => {
    const time = iso(e.time);
    if (!time || !e.log) return [];
    return [{
      time, source: `${e.log} (Ereignisanzeige)`, provider: clean(e.provider), event_id: clean(e.id),
      level: (e.level === 1 ? 'critical' : 'error') as MachineLogLevel, message: oneLine(e.message) || '(Beschreibung nicht verfügbar)',
    }];
  });
}

async function windows(since: Date, notes: string[]): Promise<MachineLogEntry[]> {
  const encoded = Buffer.from(winScript(since.toISOString()), 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 120_000);
  if (!stdout.trim()) return [];
  try {
    return mapWindowsEvents(JSON.parse(stdout) as WinEvent[]);
  } catch {
    notes.push('Ereignisprotokoll konnte nicht gelesen werden.');
    return [];
  }
}

// ───────────────────────────── Linux ─────────────────────────────

/** `journalctl -o json`: eine JSON-Zeile je Eintrag; PRIORITY 0–2 = kritisch, 3 = Fehler. Kernel-Meldungen decken Hardwarefehler ab. */
export function parseJournal(text: string): MachineLogEntry[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim().startsWith('{')) return [];
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const us = Number(j.__REALTIME_TIMESTAMP);
      if (!Number.isFinite(us)) return [];
      const prio = Number(j.PRIORITY);
      const message = Array.isArray(j.MESSAGE) ? 'binäre Meldung' : oneLine(j.MESSAGE);
      if (!message) return [];
      const kernel = j._TRANSPORT === 'kernel';
      const provider = clean(j.SYSLOG_IDENTIFIER) ?? clean(j._COMM);
      return [{
        time: new Date(us / 1000).toISOString(),
        source: kernel ? 'journal (Kernel)' : 'journal (System)',
        provider: clean(j._SYSTEMD_UNIT) ?? provider,
        event_id: null,
        level: (prio <= 2 ? 'critical' : 'error') as MachineLogLevel,
        message,
      }];
    } catch {
      return [];
    }
  });
}

/** `dmesg --time-format iso`: „2026-10-24T12:00:00,123456+02:00 Meldung“ (Hardware-/Treiberfehler, braucht oft Rechte). */
export function parseDmesg(text: string): MachineLogEntry[] {
  return text.split('\n').flatMap((line) => {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:]+)[,.]\d+([+-]\d{2}:\d{2}|Z)\s+(.*)$/.exec(line.trim());
    if (!m) return [];
    const time = iso(`${m[1]}${m[2]}`);
    return time && m[3] ? [{ time, source: 'dmesg (Kernel-Ringpuffer)', provider: 'kernel', event_id: null, level: 'error' as MachineLogLevel, message: oneLine(m[3]) }] : [];
  });
}

async function linux(since: Date, notes: string[]): Promise<MachineLogEntry[]> {
  const entries: MachineLogEntry[] = [];
  const j = await run('journalctl', ['-p', 'err', '--since', since.toISOString().replace('T', ' ').replace(/\..*$/, ' UTC'), '-o', 'json', '--no-pager', '-n', String(MAX_LOG_ENTRIES * 2)], 60_000);
  if (j.stdout.trim()) entries.push(...parseJournal(j.stdout));
  if (/not seeing messages from other users|permission|berechtigung/i.test(j.stderr)) {
    notes.push('Nur eigene Journal-Einträge sichtbar: den Agent-Benutzer zur Gruppe „systemd-journal“ (oder „adm“) hinzufügen, um System- und Kernel-Fehler zu sehen.');
  } else if (!j.stdout.trim() && !j.stderr.trim() && !fs.existsSync('/run/systemd/journal')) {
    notes.push('Kein systemd-Journal gefunden – Logs dieser Maschine werden nicht erfasst.');
  }
  const d = await run('dmesg', ['--level=err,crit,alert,emerg', '--time-format', 'iso'], 20_000);
  if (d.stdout.trim()) entries.push(...parseDmesg(d.stdout).filter((e) => e.time >= since.toISOString()));
  return entries;
}

// ───────────────────────────── macOS ─────────────────────────────

/** `log show --style ndjson`: Zeitstempel „2026-10-24 12:00:00.123456+0200“; Fehler und Faults. */
export function parseMacLog(text: string): MachineLogEntry[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim().startsWith('{')) return [];
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const ts = /^(\d{4}-\d{2}-\d{2}) ([\d:.]+)([+-]\d{2})(\d{2})$/.exec(String(j.timestamp));
      const time = ts ? iso(`${ts[1]}T${ts[2]}${ts[3]}:${ts[4]}`) : iso(j.timestamp);
      const message = oneLine(j.eventMessage);
      if (!time || !message) return [];
      const proc = clean(j.processImagePath) ? path.basename(String(j.processImagePath)) : null;
      return [{
        time, source: 'Systemprotokoll (log)', provider: clean(j.subsystem) ?? proc, event_id: null,
        level: (String(j.messageType).toLowerCase() === 'fault' ? 'critical' : 'error') as MachineLogLevel, message,
      }];
    } catch {
      return [];
    }
  });
}

/** Absturz- und Kernel-Panic-Berichte (DiagnosticReports) seit `since`. */
export function macCrashReports(since: Date, dirs: string[]): MachineLogEntry[] {
  const result: MachineLogEntry[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.(ips|crash|panic|diag)$/.test(name)) continue;
      try {
        const mtime = fs.statSync(path.join(dir, name)).mtime;
        if (mtime < since) continue;
        const panic = /panic/i.test(name);
        result.push({
          time: mtime.toISOString(), source: 'DiagnosticReports', provider: panic ? 'kernel' : clean(name.replace(/[-_]\d{4}-\d{2}-\d{2}.*$/, '')), event_id: null,
          level: panic ? 'critical' : 'error', message: `${panic ? 'Kernel-Panic' : 'Absturzbericht'}: ${name}`,
        });
      } catch {
        /* Datei verschwunden */
      }
    }
  }
  return result;
}

async function mac(since: Date, notes: string[]): Promise<MachineLogEntry[]> {
  const local = (d: Date): string => {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const r = await run('log', ['show', '--style', 'ndjson', '--start', local(since), '--predicate', 'messageType == 16 OR messageType == 17'], 180_000);
  const entries = parseMacLog(r.stdout);
  if (!r.stdout.trim() && /denied|permission|privileg/i.test(r.stderr)) notes.push('Das Systemprotokoll ist ohne Berechtigung nicht lesbar.');
  entries.push(...macCrashReports(since, ['/Library/Logs/DiagnosticReports', path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')]));
  return entries;
}

/**
 * Fehlerprotokolle der Maschine seit `since`: Windows Ereignisanzeige (System, Anwendung), Linux systemd-Journal und
 * Kernel-Ringpuffer, macOS Systemprotokoll und Absturzberichte. Nur Kritisch/Fehler, höchstens {@link MAX_LOG_ENTRIES}.
 */
export async function collectLogs(since: Date): Promise<{ entries: MachineLogEntry[]; notes: string[] }> {
  const notes: string[] = [];
  let entries: MachineLogEntry[] = [];
  try {
    if (process.platform === 'win32') entries = await windows(since, notes);
    else if (process.platform === 'darwin') entries = await mac(since, notes);
    else entries = await linux(since, notes);
  } catch (err) {
    notes.push(`Logs unvollständig gelesen: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  return { entries: finalizeLogs(entries), notes };
}
