import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProbeResult, ProbeSpec } from '@devdeck/shared';
import { ProbeScheduler, runProbe, setProbeRetryDelayForTests } from '../src/probes.js';

let web: http.Server;
let base: string;
let port: number;

beforeAll(async () => {
  setProbeRetryDelayForTests(0);
  web = http.createServer((req, res) => {
    if (req.url === '/rows') return void res.setHeader('content-type', 'application/json').end('[1,2,3]');
    if (req.url === '/fail') return void res.writeHead(500).end('x');
    res.end('gesund');
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  port = (web.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  setProbeRetryDelayForTests(3000);
  await new Promise((r) => web.close(r));
});

const spec = (over: Partial<ProbeSpec> & Pick<ProbeSpec, 'kind' | 'config'>): ProbeSpec => ({ id: 'm1', interval_seconds: 60, force: null, ...over });

describe('Monitoring-Prüfungen auf der Maschine (Agent)', () => {
  it('HTTP: Statuscode, Text, JSON-Zeilen und Fehler werden bewertet', async () => {
    expect(await runProbe(spec({ kind: 'http', config: { url: `${base}/ok`, contains: 'gesund' } }))).toMatchObject({ status: 'ok' });
    expect((await runProbe(spec({ kind: 'http', config: { url: `${base}/ok`, contains: 'krank' } }))).status).toBe('error');
    expect(await runProbe(spec({ kind: 'http', config: { url: `${base}/rows`, json_array_min: 3 } }))).toMatchObject({ status: 'ok' });
    expect((await runProbe(spec({ kind: 'http', config: { url: `${base}/rows`, json_array_min: 4 } }))).message).toContain('Nur 3 Zeile');
    expect((await runProbe(spec({ kind: 'http', config: { url: `${base}/fail` } }))).message).toBe('HTTP 500');
    expect((await runProbe(spec({ kind: 'http', config: { url: 'ftp://x' } }))).status).toBe('error');
  });

  it('TCP: offener Port ok, geschlossener Port Fehler, ungültige Eingaben werden abgelehnt', async () => {
    expect((await runProbe(spec({ kind: 'tcp', config: { host: '127.0.0.1', port } }))).status).toBe('ok');
    const closed = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
    expect((await runProbe(spec({ kind: 'tcp', config: { host: '127.0.0.1', port: closed } }))).status).toBe('error');
    expect((await runProbe(spec({ kind: 'tcp', config: { host: 'a b', port: 25 } }))).message).toContain('ungültig');
  });

  it('systemd: ungültige Unit-Namen werden nie an systemctl übergeben', async () => {
    const r = await runProbe(spec({ kind: 'systemd', config: { unit: '--help; reboot' } }));
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/ungültig|nur unter Linux/);
  });

  it('Scheduler: neue Aufträge laufen sofort, danach nach Intervall; „Jetzt prüfen“ (force) löst sofort aus; Ergebnisse bleiben bis zur Bestätigung', async () => {
    const calls: string[] = [];
    const run = async (s: ProbeSpec): Promise<ProbeResult> => {
      calls.push(s.id);
      return { id: s.id, status: 'ok', latency_ms: 1, message: 'ok', checked_at: new Date(Date.now() + calls.length).toISOString() };
    };
    const sch = new ProbeScheduler(run);
    const s1 = spec({ id: 'a', kind: 'tcp', config: { host: 'x', port: 1 }, interval_seconds: 60 });
    sch.update([s1], 1_000_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['a']);
    sch.update([s1], 1_000_000 + 30_000); // noch nicht fällig
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['a']);
    sch.update([s1], 1_000_000 + 61_000); // fällig
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['a', 'a']);
    sch.update([{ ...s1, force: 'neu' }], 1_000_000 + 62_000); // force geändert
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['a', 'a', 'a']);
    const pending = sch.pending();
    expect(pending).toHaveLength(1); // je Monitor nur das neueste Ergebnis
    sch.confirm(pending);
    expect(sch.pending()).toEqual([]);
    sch.update([], 1_000_000 + 63_000);
    sch.update([s1], 1_000_000 + 64_000); // nach Entfernen und erneutem Hinzufügen sofort
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(4);
  });
});
