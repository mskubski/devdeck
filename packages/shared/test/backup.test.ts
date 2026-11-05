import { describe, expect, it } from 'vitest';
import {
  bundleNameFor,
  isBackupDue,
  lastScheduledOccurrence,
  nextScheduledRun,
  normalizeBackupRetention,
  normalizeBackupSchedule,
  normalizeBackupSources,
  parseBundleName,
  selectBundlesToDelete,
  type BackupSchedule,
} from '../src/backup.js';

const daily: BackupSchedule = { mode: 'daily', time: '03:00', weekday: 1, every_hours: 24 };
const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi, 0);

describe('Backup: Bundle-Namen', () => {
  it('erzeugt und liest Zeitstempel-Namen im Format des PeeFinder-Skripts', () => {
    const d = local(2026, 11, 5, 3, 0);
    expect(bundleNameFor(d)).toBe('2026-11-05_030000');
    expect(parseBundleName('2026-11-05_030001')?.getHours()).toBe(3);
    expect(parseBundleName('devdeck-2026')).toBeNull();
    expect(parseBundleName('2026-13-45_990000')).toBeNull();
  });
});

describe('Backup: Zeitplan', () => {
  it('daily: fällig nach dem Zeitpunkt, nicht davor, und nach einem Lauf nicht erneut', () => {
    const before = local(2026, 11, 5, 2, 59);
    const after = local(2026, 11, 5, 3, 1);
    const lastNight = local(2026, 11, 4, 3, 0).toISOString();
    expect(isBackupDue(daily, lastNight, before)).toBe(false);
    expect(isBackupDue(daily, lastNight, after)).toBe(true);
    expect(isBackupDue(daily, local(2026, 11, 5, 3, 2).toISOString(), local(2026, 11, 5, 23, 0))).toBe(false);
  });

  it('holt einen verpassten Lauf einmal nach', () => {
    const last = local(2026, 11, 1, 3, 0).toISOString();
    expect(isBackupDue(daily, last, local(2026, 11, 5, 8, 0))).toBe(true);
    expect(isBackupDue(daily, local(2026, 11, 5, 8, 1).toISOString(), local(2026, 11, 5, 9, 0))).toBe(false);
  });

  it('weekly: nur am gewählten Wochentag (1 = Montag)', () => {
    const weekly: BackupSchedule = { ...daily, mode: 'weekly', weekday: 1 };
    const occ = lastScheduledOccurrence(weekly, local(2026, 11, 5, 12, 0)); // Donnerstag
    expect(occ?.getDay()).toBe(1);
    expect(occ?.getDate()).toBe(2);
    expect(nextScheduledRun(weekly, null, local(2026, 11, 5, 12, 0))?.getDate()).toBe(9);
  });

  it('interval und off', () => {
    const every6: BackupSchedule = { ...daily, mode: 'interval', every_hours: 6 };
    const now = local(2026, 11, 5, 12, 0);
    expect(isBackupDue(every6, null, now)).toBe(true);
    expect(isBackupDue(every6, local(2026, 11, 5, 7, 0).toISOString(), now)).toBe(false);
    expect(isBackupDue(every6, local(2026, 11, 5, 5, 59).toISOString(), now)).toBe(true);
    expect(isBackupDue({ ...daily, mode: 'off' }, null, now)).toBe(false);
    expect(nextScheduledRun({ ...daily, mode: 'off' }, null, now)).toBeNull();
  });

  it('validiert Eingaben', () => {
    expect(() => normalizeBackupSchedule({ mode: 'monatlich' })).toThrow();
    expect(() => normalizeBackupSchedule({ mode: 'daily', time: '7:00' })).toThrow();
    expect(() => normalizeBackupSchedule({ mode: 'weekly', time: '07:00', weekday: 9 })).toThrow();
    expect(normalizeBackupSchedule({ mode: 'daily', time: '07:30' }).time).toBe('07:30');
  });
});

describe('Backup: Aufbewahrung', () => {
  const day = (n: number) => ({ name: `b${n}`, created_at: new Date(Date.UTC(2026, 10, 5) - n * 86_400_000).toISOString() });
  const now = new Date(Date.UTC(2026, 10, 5, 12));

  it('löscht Backups über der Altersgrenze, behält aber immer die neuesten keep_min', () => {
    const all = [0, 1, 2, 10, 20, 31, 40, 50].map(day);
    expect(selectBundlesToDelete(all, { keep_days: 30, keep_min: 5 }, now).sort()).toEqual(['b31', 'b40', 'b50']);
    expect(selectBundlesToDelete(all, { keep_days: 30, keep_min: 8 }, now)).toEqual([]);
    expect(selectBundlesToDelete(all, { keep_days: 1, keep_min: 1 }, now).sort()).toEqual(['b1', 'b10', 'b2', 'b20', 'b31', 'b40', 'b50']);
  });

  it('löscht nie, wenn weniger als keep_min vorhanden sind', () => {
    expect(selectBundlesToDelete([day(400), day(500)], { keep_days: 1, keep_min: 5 }, now)).toEqual([]);
  });

  it('validiert Grenzen', () => {
    expect(() => normalizeBackupRetention({ keep_days: 0 })).toThrow();
    expect(() => normalizeBackupRetention({ keep_min: 1.5 })).toThrow();
    expect(normalizeBackupRetention({})).toEqual({ keep_days: 30, keep_min: 5 });
  });
});

describe('Backup: Quellen', () => {
  const supabase = { id: 'supabase', kind: 'supabase', label: 'S', config: { url_secret: 'NEXT_PUBLIC_SUPABASE_URL', key_secret: 'SUPABASE_SERVICE_ROLE_KEY', environment: 'production', evil: 'x' } };

  it('normalisiert und verwirft unbekannte Felder', () => {
    const [s] = normalizeBackupSources([supabase]);
    expect(s!.config).toEqual({ url_secret: 'NEXT_PUBLIC_SUPABASE_URL', key_secret: 'SUPABASE_SERVICE_ROLE_KEY', environment: 'production', buckets: [], schema: true });
  });

  it('lehnt ungültige Quellen ab', () => {
    expect(() => normalizeBackupSources([])).toThrow();
    expect(() => normalizeBackupSources([{ id: 'x', kind: 'ftp', label: 'x', config: {} }])).toThrow();
    expect(() => normalizeBackupSources([{ ...supabase, config: { ...supabase.config, key_secret: 'bad name; rm -rf' } }])).toThrow();
    expect(() => normalizeBackupSources([{ id: '../x', kind: 'files', label: 'x', config: { path: '/a' } }])).toThrow();
    expect(() => normalizeBackupSources([supabase, { ...supabase, id: 'supabase2' }])).toThrow(/Supabase/);
    expect(() => normalizeBackupSources([{ id: 'a', kind: 'files', label: 'A', enabled: false, config: { path: '/a' } }])).toThrow(/aktiv/);
  });
});
