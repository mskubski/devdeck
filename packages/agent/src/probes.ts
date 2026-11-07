import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { SYSTEMD_UNIT_PATTERN, judgeHttp, type ProbeResult, type ProbeSpec } from '@devdeck/shared';

const exec = promisify(execFile);
const retry = { delayMs: 3000 };
/** Pause vor dem zweiten Versuch (Tests setzen sie auf 0). */
export function setProbeRetryDelayForTests(ms: number): void {
  retry.delayMs = ms;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Monitoring auf der Maschine: Der Server gibt per Heartbeat-Antwort die Prüfaufträge dieser Maschine mit (HTTP/TCP vom Standort der Maschine aus, systemd-Dienste);
 * der Agent führt sie nach ihrem Intervall aus und meldet die Ergebnisse mit dem nächsten Heartbeat. Es werden nie Befehle von außen ausgeführt –
 * nur diese festen Prüfarten mit streng geprüften Parametern (Unit-Namen nur aus erlaubten Zeichen, `systemctl is-active`).
 */

async function httpProbe(cfg: Record<string, any>): Promise<Pick<ProbeResult, 'status' | 'latency_ms' | 'message'>> {
  let url: URL;
  try {
    url = new URL(String(cfg.url));
  } catch {
    return { status: 'error', latency_ms: null, message: 'URL ungültig' };
  }
  if (!/^https?:$/.test(url.protocol)) return { status: 'error', latency_ms: null, message: 'Nur http(s) erlaubt' };
  const headers: Record<string, string> = { 'User-Agent': 'DevDeck-Monitoring/1' };
  for (const h of (cfg.headers ?? []) as Array<{ name?: string; value?: string }>) if (h.name && typeof h.value === 'string') headers[h.name] = h.value;
  const timeout = Math.min(30_000, Number(cfg.timeout_ms ?? 10_000));
  const needBody = Boolean(cfg.contains) || cfg.json_array_min !== undefined;
  let last: Pick<ProbeResult, 'status' | 'latency_ms' | 'message'> = { status: 'error', latency_ms: null, message: 'keine Antwort' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await sleep(retry.delayMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const started = Date.now();
    try {
      const res = await fetch(url, { method: cfg.method === 'HEAD' || cfg.method === 'POST' ? cfg.method : 'GET', headers, body: cfg.method === 'POST' ? String(cfg.body ?? '') : undefined, signal: ctl.signal, redirect: 'follow' });
      const text = needBody ? (await res.text()).slice(0, 1_000_000) : '';
      if (!needBody) await res.body?.cancel().catch(() => undefined);
      const v = judgeHttp(cfg, { status: res.status, latency_ms: Date.now() - started, text });
      last = { status: v.status, latency_ms: Date.now() - started, message: v.message };
      if (v.status !== 'error' || !v.retryable) return last;
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      last = { status: 'error', latency_ms: null, message: aborted ? `Zeitüberschreitung (${Math.round(timeout / 1000)} s)` : `Netzfehler (${(err as { cause?: { code?: string } })?.cause?.code ?? (err instanceof Error ? err.message : 'unbekannt')})` };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

async function tcpProbe(cfg: Record<string, any>): Promise<Pick<ProbeResult, 'status' | 'latency_ms' | 'message'>> {
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(String(cfg.host))) return { status: 'error', latency_ms: null, message: 'Host oder Port ungültig' };
  const timeout = Math.min(30_000, Number(cfg.timeout_ms ?? 8000));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await sleep(retry.delayMs);
    const started = Date.now();
    const r = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const s = net.createConnection({ host: String(cfg.host).replace(/^\[|\]$/g, ''), port, timeout });
      s.once('connect', () => { s.destroy(); resolve({ ok: true, message: '' }); });
      s.once('timeout', () => { s.destroy(); resolve({ ok: false, message: `Zeitüberschreitung (${Math.round(timeout / 1000)} s)` }); });
      s.once('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, message: `Verbindung fehlgeschlagen (${e.code ?? e.message})` }));
    });
    const latency = Date.now() - started;
    if (r.ok) return { status: latency > Number(cfg.warn_latency_ms ?? 3000) ? 'warn' : 'ok', latency_ms: latency, message: `Port ${port} erreichbar, ${latency} ms` };
    if (attempt === 1) return { status: 'error', latency_ms: latency, message: r.message };
  }
  return { status: 'error', latency_ms: null, message: 'keine Verbindung' };
}

async function systemdProbe(cfg: Record<string, any>): Promise<Pick<ProbeResult, 'status' | 'latency_ms' | 'message'>> {
  const unit = String(cfg.unit ?? '');
  if (process.platform !== 'linux') return { status: 'error', latency_ms: null, message: 'systemd gibt es nur unter Linux' };
  if (!SYSTEMD_UNIT_PATTERN.test(unit)) return { status: 'error', latency_ms: null, message: 'Unit-Name ungültig' };
  const args = [...(cfg.scope === 'system' ? [] : ['--user']), 'is-active', '--', unit];
  try {
    const { stdout } = await exec('systemctl', args, { timeout: 10_000 });
    const state = stdout.trim();
    return { status: state === 'active' ? 'ok' : 'warn', latency_ms: null, message: `Dienst ${unit}: ${state}` };
  } catch (err) {
    const e = err as { stdout?: string; code?: string | number; message?: string };
    if (e.code === 'ENOENT') return { status: 'error', latency_ms: null, message: 'systemctl ist nicht verfügbar' };
    const state = String(e.stdout ?? '').trim();
    // „inactive“/„failed“/„unknown“: Exit-Code ≠ 0, die Ausgabe nennt den Zustand
    return { status: 'error', latency_ms: null, message: state ? `Dienst ${unit}: ${state}` : `Dienst ${unit} nicht abfragbar (${(e.message ?? '').slice(0, 120)})` };
  }
}

export async function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
  const checked_at = new Date().toISOString();
  try {
    const r = spec.kind === 'http' ? await httpProbe(spec.config) : spec.kind === 'tcp' ? await tcpProbe(spec.config) : await systemdProbe(spec.config);
    return { id: spec.id, checked_at, ...r };
  } catch (err) {
    return { id: spec.id, checked_at, status: 'error', latency_ms: null, message: `Prüfung fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}` };
  }
}

/** Führt die Prüfaufträge nach ihrem Intervall aus und sammelt die Ergebnisse für den nächsten Heartbeat. */
export class ProbeScheduler {
  private specs = new Map<string, ProbeSpec>();
  private lastRun = new Map<string, number>();
  private lastForce = new Map<string, string | null>();
  private running = new Set<string>();
  private results: ProbeResult[] = [];

  constructor(private readonly run: (spec: ProbeSpec) => Promise<ProbeResult> = runProbe) {}

  /** Neue Aufträge übernehmen (Heartbeat-Antwort); fällige starten im Hintergrund. */
  update(list: ProbeSpec[] | undefined, now = Date.now()): void {
    const next = new Map((list ?? []).map((s) => [s.id, s]));
    for (const id of [...this.specs.keys()]) {
      if (!next.has(id)) {
        this.lastRun.delete(id);
        this.lastForce.delete(id);
      }
    }
    this.specs = next;
    let started = 0;
    for (const s of next.values()) {
      const forced = this.lastForce.has(s.id) && this.lastForce.get(s.id) !== s.force;
      const due = !this.lastRun.has(s.id) || now - this.lastRun.get(s.id)! >= s.interval_seconds * 1000 - 2000 || forced;
      this.lastForce.set(s.id, s.force);
      if (!due || this.running.has(s.id) || started >= 4) continue;
      started += 1;
      this.running.add(s.id);
      this.lastRun.set(s.id, now);
      void this.run(s).then((r) => {
        this.results = [...this.results.filter((x) => x.id !== r.id), r].slice(-200);
      }).finally(() => this.running.delete(s.id));
    }
  }

  /** Ergebnisse zum Senden (bleiben erhalten, bis `confirm` sie entfernt). */
  pending(): ProbeResult[] {
    return [...this.results];
  }

  confirm(sent: ProbeResult[]): void {
    const keys = new Set(sent.map((r) => `${r.id}|${r.checked_at}`));
    this.results = this.results.filter((r) => !keys.has(`${r.id}|${r.checked_at}`));
  }
}
