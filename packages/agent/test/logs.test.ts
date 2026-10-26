import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectLogs, finalizeLogs, macCrashReports, mapWindowsEvents, parseDmesg, parseJournal, parseMacLog } from '../src/logs.js';

describe('System-Logs (Agent)', () => {
  it('Windows: Ereignisse mit Log, Anbieter, ID und Ebene', () => {
    const r = mapWindowsEvents([
      { time: '2026-10-24T12:33:43.7450000Z', log: 'System', provider: 'disk', id: '7', level: 2, message: 'Das Gerät \\Device\\Harddisk1\\DR1 hat einen defekten Block.\r\nWeitere Zeile' },
      { time: '2026-10-24T12:00:00Z', log: 'Application', provider: 'Application Error', id: '1000', level: 1, message: '' },
      { time: 'kaputt', log: 'System' },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ source: 'System (Ereignisanzeige)', provider: 'disk', event_id: '7', level: 'error', time: '2026-10-24T12:33:43.745Z' });
    expect(r[0]!.message).toContain('defekten Block');
    expect(r[1]).toMatchObject({ level: 'critical', message: '(Beschreibung nicht verfügbar)' });
    expect(mapWindowsEvents(null)).toEqual([]);
  });

  it('Linux: journalctl-JSON mit Kernel- und Dienstmeldungen', () => {
    const lines = [
      JSON.stringify({ __REALTIME_TIMESTAMP: '1792843200000000', PRIORITY: '3', SYSLOG_IDENTIFIER: 'kernel', _TRANSPORT: 'kernel', MESSAGE: 'nvme nvme0: I/O 12 timeout' }),
      JSON.stringify({ __REALTIME_TIMESTAMP: '1792843300000000', PRIORITY: '2', SYSLOG_IDENTIFIER: 'sshd', _SYSTEMD_UNIT: 'ssh.service', MESSAGE: 'fatal: no hostkeys' }),
      JSON.stringify({ __REALTIME_TIMESTAMP: '1792843400000000', PRIORITY: '3', MESSAGE: [1, 2, 3] }),
      'kein json',
    ].join('\n');
    const r = parseJournal(lines);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ source: 'journal (Kernel)', provider: 'kernel', level: 'error', message: 'nvme nvme0: I/O 12 timeout' });
    expect(r[1]).toMatchObject({ source: 'journal (System)', provider: 'ssh.service', level: 'critical' });
    expect(r[2]!.message).toBe('binäre Meldung');
  });

  it('Linux: dmesg mit ISO-Zeit', () => {
    const r = parseDmesg('2026-10-24T12:00:00,123456+02:00 ata1.00: failed command: READ FPDMA QUEUED\nirgendwas ohne Zeit\n');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'dmesg (Kernel-Ringpuffer)', time: '2026-10-24T10:00:00.000Z' });
  });

  it('macOS: log-ndjson (Error/Fault) und Absturzberichte', () => {
    const text = [
      JSON.stringify({ timestamp: '2026-10-24 12:00:00.123456+0200', messageType: 'Error', subsystem: 'com.apple.bluetooth', eventMessage: 'Verbindung verloren', processImagePath: '/usr/sbin/bluetoothd' }),
      JSON.stringify({ timestamp: '2026-10-24 12:01:00.000000+0200', messageType: 'Fault', eventMessage: 'Speicherfehler', processImagePath: '/System/Library/foo/launchd' }),
    ].join('\n');
    const r = parseMacLog(text);
    expect(r[0]).toMatchObject({ source: 'Systemprotokoll (log)', provider: 'com.apple.bluetooth', level: 'error', time: '2026-10-24T10:00:00.123Z' });
    expect(r[1]).toMatchObject({ provider: 'launchd', level: 'critical' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-diag-'));
    fs.writeFileSync(path.join(dir, 'Kernel_2026-10-24-120000.panic'), 'x');
    fs.writeFileSync(path.join(dir, 'Safari_2026-10-24-120000.ips'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const crashes = macCrashReports(new Date(Date.now() - 3600_000), [dir, path.join(dir, 'gibt-es-nicht')]);
    expect(crashes.map((c) => [c.level, c.provider])).toEqual(expect.arrayContaining([['critical', 'kernel'], ['error', 'Safari']]));
    expect(crashes).toHaveLength(2);
    expect(macCrashReports(new Date(Date.now() + 3600_000), [dir])).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('begrenzt, sortiert (neueste zuerst) und entfernt Duplikate', () => {
    const mk = (time: string, message = 'm') => ({ time, source: 's', provider: null, event_id: null, level: 'error' as const, message });
    const r = finalizeLogs([mk('2026-01-01T00:00:00Z'), mk('2026-01-03T00:00:00Z'), mk('2026-01-02T00:00:00Z'), mk('2026-01-03T00:00:00Z')], 2);
    expect(r.map((e) => e.time)).toEqual(['2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z'].map((t) => t.replace('.000Z', 'Z')).slice(0, 2));
  });

  it('liest auf dieser Maschine Logs, ohne zu scheitern', async () => {
    const r = await collectLogs(new Date(Date.now() - 86_400_000));
    expect(Array.isArray(r.entries)).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
    for (const e of r.entries.slice(0, 3)) expect(e.source).toBeTruthy();
  }, 200_000);
});
