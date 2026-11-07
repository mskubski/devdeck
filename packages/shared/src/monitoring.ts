/** DevDeck – Monitoring: gemeinsame Typen und Regeln (Server, Agent, Oberfläche). */

export const MONITOR_KINDS = ['http', 'tcp', 'systemd', 'machine', 'disk', 'patches', 'backup', 'replica', 'connector'] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

/** Arten, die der Server selbst über das Netz prüft (oder – mit `machine_id` – der Agent einer Maschine). */
export const NETWORK_KINDS: readonly MonitorKind[] = ['http', 'tcp'];
/** Arten, die immer auf einer Maschine laufen (Agent). */
export const AGENT_ONLY_KINDS: readonly MonitorKind[] = ['systemd'];

export const MONITOR_ENVIRONMENTS = ['prod', 'dev'] as const;
export type MonitorEnvironment = (typeof MONITOR_ENVIRONMENTS)[number];

/** ok = grün, warn = gelb (Warnung), error = rot (Ausfall/Fehler), unknown = noch keine Messung. */
export type MonitorStatus = 'ok' | 'warn' | 'error' | 'unknown';

const RANK: Record<MonitorStatus, number> = { unknown: 0, ok: 1, warn: 2, error: 3 };

/** Schlechtester Status einer Liste (error > warn > ok > unknown); leer = unknown. */
export function worstStatus(list: MonitorStatus[]): MonitorStatus {
  let worst: MonitorStatus = 'unknown';
  for (const s of list) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

/** Gesamtstatus eines Projekts: nur aktive Monitore; Produktion zählt voll, Entwicklung höchstens als Warnung, `cap` begrenzt einzelne Monitore. */
export function projectStatus(monitors: Array<{ status: MonitorStatus; environment: string; enabled: boolean; severity_cap: 'error' | 'warn' }>): MonitorStatus {
  const effective = monitors
    .filter((m) => m.enabled)
    .map((m): MonitorStatus => {
      let s = m.status;
      if (s === 'error' && (m.severity_cap === 'warn' || m.environment !== 'prod')) s = 'warn';
      return s;
    });
  return worstStatus(effective);
}

/** Vom Server an den Agenten übergebener Prüfauftrag (in der Heartbeat-Antwort). */
export interface ProbeSpec {
  id: string;
  kind: 'http' | 'tcp' | 'systemd';
  config: Record<string, unknown>;
  interval_seconds: number;
  /** ändert sich, wenn „Jetzt prüfen“ gedrückt wurde → der Agent prüft sofort */
  force: string | null;
}

/** Ergebnis einer Prüfung auf der Maschine (mit dem nächsten Heartbeat an den Server). */
export interface ProbeResult {
  id: string;
  status: 'ok' | 'warn' | 'error';
  latency_ms: number | null;
  message: string;
  checked_at: string;
}

/** Erlaubte Zeichen: Unit-Namen für `systemctl` (keine Optionen, keine Leerzeichen). */
export const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,99}$/;

export const MIN_AGENT_VERSION_FOR_PROBES = '0.18.0';

export const MIN_AGENT_VERSION_FOR_PROBES_LABEL = MIN_AGENT_VERSION_FOR_PROBES;

export interface HttpExpectation {
  expect?: 'ok' | 'reachable' | 'status';
  status?: number;
  contains?: string;
  json_array_min?: number;
  warn_latency_ms?: number;
}

/**
 * Bewertung einer HTTP-Antwort (Server und Agent urteilen gleich): Statuscode (ok = 200–399, reachable = unter 500, status = genau dieser),
 * Textinhalt, Anzahl JSON-Zeilen und Antwortzeit. `retryable`: der Fehler könnte vorübergehend sein (5xx).
 */
export function judgeHttp(cfg: HttpExpectation, res: { status: number; latency_ms: number; text: string }): { status: 'ok' | 'warn' | 'error'; message: string; retryable: boolean } {
  const okStatus = cfg.expect === 'status' ? res.status === cfg.status : cfg.expect === 'reachable' ? res.status < 500 : res.status >= 200 && res.status < 400;
  if (!okStatus) return { status: 'error', message: `HTTP ${res.status}${cfg.expect === 'status' ? ` (erwartet ${cfg.status})` : ''}`, retryable: res.status >= 500 };
  if (cfg.contains && !res.text.includes(cfg.contains)) return { status: 'error', message: `Antwort enthält „${cfg.contains.slice(0, 40)}“ nicht`, retryable: false };
  if (cfg.json_array_min !== undefined) {
    let rows = -1;
    try {
      const j: unknown = JSON.parse(res.text);
      rows = Array.isArray(j) ? j.length : -1;
    } catch {
      /* kein JSON */
    }
    if (rows < 0) return { status: 'error', message: 'Antwort ist keine JSON-Liste', retryable: false };
    if (rows < cfg.json_array_min) return { status: 'error', message: `Nur ${rows} Zeile(n) statt mindestens ${cfg.json_array_min}`, retryable: false };
  }
  if (res.latency_ms > (cfg.warn_latency_ms ?? 3000)) return { status: 'warn', message: `Antwort langsam: ${res.latency_ms} ms (HTTP ${res.status})`, retryable: false };
  return { status: 'ok', message: `HTTP ${res.status}, ${res.latency_ms} ms`, retryable: false };
}
