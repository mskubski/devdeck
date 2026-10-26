import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_RETENTION_DAYS, pruneMachineLogs, sanitizeLogReport } from '../src/services/machineLogs.js';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe('Maschinen-Logs (Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let machineId: string;
  let machineToken: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const enrolled = await srv.enroll(cookie, 'log-pc');
    machineId = enrolled.machineId;
    machineToken = enrolled.token;
  });
  afterEach(async () => {
    await srv.close();
  });

  const entry = (over: Record<string, unknown> = {}) => ({
    time: ago(60_000), source: 'System (Ereignisanzeige)', provider: 'disk', event_id: '7', level: 'error', message: 'Defekter Block', ...over,
  });
  const beat = (logs: unknown) => srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.14.0', logs } });
  const read = async (qs = '') => (await srv.request('GET', `/api/machines/${machineId}/logs${qs}`, { cookie })).body.data;

  it('speichert Einträge bereinigt, ignoriert Doppelte und liefert Quellen-Zähler', async () => {
    const report = {
      collected_at: ago(1000),
      entries: [
        entry(),
        entry({ source: 'Application (Ereignisanzeige)', provider: 'Application Error', event_id: '1000', level: 'critical', message: 'Absturz', time: ago(30_000) }),
        entry({ message: '' }), // leer
        entry({ time: 'kaputt' }),
        entry({ time: ago(40 * DAY) }), // älter als die Aufbewahrung
        entry({ time: new Date(Date.now() + 5 * DAY).toISOString() }), // Zukunft
        entry({ level: 'komisch', message: 'Ebene wird normalisiert', time: ago(10_000) }),
      ],
      notes: ['Hinweis', 5],
    };
    expect((await beat(report)).status).toBe(200);
    await beat(report); // dasselbe nochmal: keine Duplikate
    const d = await read();
    expect(d.total).toBe(3);
    expect(d.entries.map((e: { message: string }) => e.message)).toEqual(['Ebene wird normalisiert', 'Absturz', 'Defekter Block']);
    expect(d.entries[0].level).toBe('error');
    expect(d.sources).toEqual(expect.arrayContaining([{ source: 'System (Ereignisanzeige)', count: 2 }, { source: 'Application (Ereignisanzeige)', count: 1 }]));
    expect(d.notes).toEqual(['Hinweis']);
    expect(d.retention_days).toBe(LOG_RETENTION_DAYS);
    expect(d.logs_at).toBeTruthy();
  });

  it('filtert nach Log, Ebene und Text (auch mit Sonderzeichen)', async () => {
    await beat({ collected_at: ago(1000), entries: [
      entry({ message: '100% Auslastung_Fehler', time: ago(3000) }),
      entry({ source: 'journal (Kernel)', provider: 'kernel', level: 'critical', message: 'nvme timeout', time: ago(2000) }),
      entry({ message: 'anderes', time: ago(1000) }),
    ] });
    expect((await read('?source=journal%20(Kernel)')).entries).toHaveLength(1);
    expect((await read('?level=critical')).entries.map((e: { message: string }) => e.message)).toEqual(['nvme timeout']);
    expect((await read('?q=100%25%20Auslastung_')).entries).toHaveLength(1);
    expect((await read('?q=100%25')).entries).toHaveLength(1);
    expect((await read('?q=%25')).entries).toHaveLength(1); // „%“ wird wörtlich gesucht
    expect((await read('?q=NVME')).entries).toHaveLength(1);
    expect((await read('?limit=1')).entries).toHaveLength(1);
  });

  it('behält Logs bei Heartbeats ohne Logs; ein leerer Bericht setzt nur „zuletzt gelesen“', async () => {
    await beat({ collected_at: ago(5000), entries: [entry()] });
    await srv.request('POST', '/api/agent/heartbeat', { token: machineToken, body: { agent_version: '0.14.0' } });
    expect((await read()).total).toBe(1);
    await beat({ collected_at: ago(1000), entries: [], notes: ['Nur eigene Journal-Einträge sichtbar'] });
    const d = await read();
    expect(d.total).toBe(1);
    expect(d.notes).toEqual(['Nur eigene Journal-Einträge sichtbar']);
  });

  it('löscht Einträge nach 30 Tagen und begrenzt je Maschine', async () => {
    const db = srv.ctx.db;
    const insert = (i: number, occurred: string) =>
      db.run(
        `INSERT INTO machine_logs (machine_id, occurred_at, source, provider, event_id, level, message, hash, created_at) VALUES (?, ?, 's', NULL, NULL, 'error', ?, ?, ?)`,
        machineId, occurred, `m${i}`, `h${i}`, new Date().toISOString(),
      );
    insert(1, ago(31 * DAY));
    insert(2, ago(29 * DAY));
    for (let i = 3; i < 13; i += 1) insert(i, ago(i * 1000));
    expect(pruneMachineLogs(db, { maxPerMachine: 100 })).toBe(1); // nur der 31 Tage alte
    expect((await read()).total).toBe(11);
    expect(pruneMachineLogs(db, { machineId, maxPerMachine: 5 })).toBe(6); // Obergrenze: die 5 neuesten bleiben
    const d = await read();
    expect(d.total).toBe(5);
    expect(d.entries.map((e: { message: string }) => e.message)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('räumt beim Heartbeat auf und verlangt Zugriffsrechte', async () => {
    srv.ctx.db.run(
      `INSERT INTO machine_logs (machine_id, occurred_at, source, provider, event_id, level, message, hash, created_at) VALUES (?, ?, 's', NULL, NULL, 'error', 'uralt', 'x', ?)`,
      machineId, ago(45 * DAY), new Date().toISOString(),
    );
    await beat({ collected_at: ago(1000), entries: [entry()] });
    expect((await read()).entries.map((e: { message: string }) => e.message)).toEqual(['Defekter Block']);
    await srv.request('POST', '/api/users', { cookie, body: { email: 'fremd6@devdeck.test', password: 'fremd-pass-123' } });
    const foreign = await srv.login('fremd6@devdeck.test', 'fremd-pass-123');
    expect((await srv.request('GET', `/api/machines/${machineId}/logs`, { cookie: foreign })).status).toBe(403);
  });

  it('sanitizeLogReport lehnt Unsinn ab', () => {
    expect(sanitizeLogReport(null)).toBeNull();
    expect(sanitizeLogReport([])).toBeNull();
    expect(sanitizeLogReport({ entries: 'x' })?.entries).toEqual([]);
  });
});
