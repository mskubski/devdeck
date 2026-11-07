import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import {
  AppError,
  MONITOR_ENVIRONMENTS,
  MONITOR_KINDS,
  MIN_AGENT_VERSION_FOR_PROBES,
  SYSTEMD_UNIT_PATTERN,
  compareVersions,
  judgeHttp,
  projectStatus,
  worstStatus,
  type MonitorKind,
  type MonitorStatus,
  type ProbeResult,
  type ProbeSpec,
} from '@devdeck/shared';
import type { AppContext } from '../context.js';
import type { MachineRecord } from '../auth/middleware.js';
import { audit } from './audit.js';
import { getReplica } from './backupReplicas.js';
import { buildArchitecture } from './architecture/build.js';

/**
 * Monitoring: Überwachung von Umgebungen (Produktion/Entwicklung) je Projekt – Websites, APIs, Datenbanken (Supabase), Mail-Server, Karten-Kacheln,
 * Server/Dienste auf Maschinen (per Agent), Datenträger, Updates, Backups und Repliken. Jeder Monitor hat einen Status (grün/gelb/rot) und einen Verlauf.
 */

export interface MonitorRow {
  id: string;
  project_id: string | null;
  name: string;
  kind: MonitorKind;
  environment: 'prod' | 'dev';
  group_label: string | null;
  config_json: string;
  machine_id: string | null;
  interval_seconds: number;
  enabled: number;
  severity_cap: 'error' | 'warn';
  allow_private: number;
  auto_key: string | null;
  force_token: string | null;
  status: MonitorStatus;
  status_since: string | null;
  last_checked_at: string | null;
  last_latency_ms: number | null;
  last_message: string | null;
  details_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Actor {
  id: string | null;
  label: string;
  isAdmin: boolean;
  ip?: string | null;
}

export interface CheckResult {
  status: MonitorStatus;
  latency_ms: number | null;
  message: string;
  details?: Record<string, unknown>;
}

const parse = <T>(v: string | null | undefined, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const DEFAULT_INTERVAL: Record<MonitorKind, number> = { http: 300, tcp: 300, systemd: 60, machine: 60, disk: 300, patches: 3600, backup: 900, replica: 300, connector: 900 };
const MIN_INTERVAL = 30;
const KEEP_CHECKS_DAYS = 7;
const KEEP_CHECKS_MAX = 2000;

/** Arten, die auf der Maschine selbst geprüft werden (Agent, per Heartbeat): systemd immer, http/tcp wenn eine Maschine gewählt ist. */
export const isAgentBound = (m: Pick<MonitorRow, 'kind' | 'machine_id'>): boolean => m.kind === 'systemd' || ((m.kind === 'http' || m.kind === 'tcp') && Boolean(m.machine_id));

// ───────────────────────────── Eingaben prüfen ─────────────────────────────

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
};
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:]+\]$/;

function normalizeHeaders(raw: unknown, projectId: string | null): Array<{ name: string; value?: string; secret?: { name: string; environment: string } }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 6) throw new AppError('VALIDATION', 'headers: höchstens 6 Einträge');
  return raw.map((h) => {
    const name = str((h as { name?: unknown })?.name, 60);
    if (!name || !/^[A-Za-z0-9-]+$/.test(name)) throw new AppError('VALIDATION', 'Ungültiger Header-Name');
    const secret = (h as { secret?: { name?: unknown; environment?: unknown } }).secret;
    if (secret) {
      if (!projectId) throw new AppError('VALIDATION', 'Secrets lassen sich nur in Projekt-Monitoren verwenden');
      const sname = str(secret.name, 100);
      if (!sname) throw new AppError('VALIDATION', 'Header-Secret: Name fehlt');
      return { name, secret: { name: sname, environment: str(secret.environment, 30) ?? 'production' } };
    }
    const value = str((h as { value?: unknown }).value, 500);
    if (value === undefined) throw new AppError('VALIDATION', `Header ${name}: Wert oder Secret fehlt`);
    return { name, value };
  });
}

/** Konfiguration je Art prüfen und mit Standardwerten ergänzen. */
export function normalizeConfig(ctx: AppContext, kind: MonitorKind, raw: unknown, scope: { projectId: string | null; machineId: string | null }): Record<string, unknown> {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  switch (kind) {
    case 'http': {
      let url: URL;
      try {
        url = new URL(String(c.url ?? ''));
      } catch {
        throw new AppError('VALIDATION', 'URL ungültig (https://…)');
      }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new AppError('VALIDATION', 'Nur http(s)-URLs ohne Zugangsdaten in der Adresse');
      const method = c.method === 'HEAD' || c.method === 'POST' ? c.method : 'GET';
      const expect = c.expect === 'reachable' || c.expect === 'status' ? c.expect : 'ok';
      return {
        url: url.toString().slice(0, 500), method, expect,
        ...(expect === 'status' ? { status: int(c.status, 100, 599, 200) } : {}),
        ...(method === 'POST' && str(c.body, 2000) ? { body: str(c.body, 2000) } : {}),
        ...(str(c.contains, 200) ? { contains: str(c.contains, 200) } : {}),
        ...(c.json_array_min !== undefined ? { json_array_min: int(c.json_array_min, 0, 1000, 1) } : {}),
        warn_latency_ms: int(c.warn_latency_ms, 100, 60_000, 3000),
        timeout_ms: int(c.timeout_ms, 1000, 30_000, 10_000),
        cert_warn_days: int(c.cert_warn_days, 1, 90, 14),
        headers: normalizeHeaders(c.headers, scope.projectId),
      };
    }
    case 'tcp': {
      const host = str(c.host, 253);
      if (!host || !HOST_RE.test(host)) throw new AppError('VALIDATION', 'Host ungültig');
      const port = Number(c.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new AppError('VALIDATION', 'Port ungültig (1–65535)');
      return { host, port, tls: c.tls === true, timeout_ms: int(c.timeout_ms, 1000, 30_000, 8000), cert_warn_days: int(c.cert_warn_days, 1, 90, 14), warn_latency_ms: int(c.warn_latency_ms, 100, 60_000, 3000) };
    }
    case 'systemd': {
      const unit = str(c.unit, 100);
      if (!unit || !SYSTEMD_UNIT_PATTERN.test(unit)) throw new AppError('VALIDATION', 'Unit-Name ungültig');
      return { unit, scope: c.scope === 'system' ? 'system' : 'user' };
    }
    case 'machine':
      return {};
    case 'disk': {
      const warn = int(c.warn_free_pct, 1, 90, 15);
      return { warn_free_pct: warn, error_free_pct: Math.min(warn - 1 || 1, int(c.error_free_pct, 1, 89, 5)) };
    }
    case 'patches':
      return {};
    case 'backup':
    case 'replica': {
      const target = str(c.target, 60);
      if (!target) throw new AppError('VALIDATION', 'Ziel fehlt (system oder Job-ID)');
      if (target === 'system') {
        if (scope.projectId) throw new AppError('VALIDATION', 'System-Backups gehören zu einem System-Monitor (ohne Projekt)');
      } else {
        const job = ctx.db.get<{ project_id: string }>('SELECT project_id FROM backup_jobs WHERE id = ?', target);
        if (!job || job.project_id !== scope.projectId) throw new AppError('VALIDATION', 'Backup-Job gehört nicht zu diesem Projekt');
      }
      return kind === 'backup' ? { target, warn_hours: int(c.warn_hours, 1, 24 * 60, 36), error_hours: int(c.error_hours, 1, 24 * 90, 72) } : { target };
    }
    case 'connector': {
      const id = str(c.connector_id, 60);
      const row = id ? ctx.db.get<{ project_id: string }>('SELECT project_id FROM project_connectors WHERE id = ?', id) : undefined;
      if (!id || !row || row.project_id !== scope.projectId) throw new AppError('VALIDATION', 'Integration gehört nicht zu diesem Projekt');
      return { connector_id: id };
    }
  }
}

export interface MonitorInput {
  project_id?: unknown;
  name?: unknown;
  kind?: unknown;
  environment?: unknown;
  group?: unknown;
  config?: unknown;
  machine_id?: unknown;
  interval_seconds?: unknown;
  enabled?: unknown;
  severity_cap?: unknown;
}

function machineFor(ctx: AppContext, kind: MonitorKind, id: unknown, needVersion: boolean): MachineRecord | null {
  const needs = kind === 'systemd' || kind === 'machine' || kind === 'disk' || kind === 'patches';
  if (id === undefined || id === null || id === '') {
    if (needs) throw new AppError('VALIDATION', 'Für diese Art muss eine Maschine gewählt werden');
    return null;
  }
  const m = ctx.db.get<MachineRecord>('SELECT * FROM machines WHERE id = ?', String(id));
  if (!m || m.revoked_at) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden oder widerrufen');
  if (needVersion && (!m.agent_version || compareVersions(m.agent_version, MIN_AGENT_VERSION_FOR_PROBES) < 0)) {
    throw new AppError('VALIDATION', `Der Agent auf „${m.name}“ (Version ${m.agent_version ?? 'unbekannt'}) kann noch keine Prüfungen ausführen – bitte zuerst aktualisieren (ab ${MIN_AGENT_VERSION_FOR_PROBES}).`);
  }
  return m;
}

/** Ziele im privaten Netz (Loopback, LAN, Link-Local) darf nur ein Administrator überwachen. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function assertPublicTarget(host: string): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare.toLowerCase() === 'localhost') throw new AppError('FORBIDDEN', 'Ziel liegt im privaten Netz – das darf nur ein Administrator überwachen');
  const addrs = net.isIP(bare) ? [{ address: bare }] : await dns.lookup(bare, { all: true }).catch(() => []);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new AppError('FORBIDDEN', 'Ziel liegt im privaten Netz – das darf nur ein Administrator überwachen');
}

function targetHost(kind: MonitorKind, cfg: Record<string, unknown>): string | null {
  if (kind === 'http') return new URL(String(cfg.url)).hostname;
  if (kind === 'tcp') return String(cfg.host);
  return null;
}

export async function createMonitor(ctx: AppContext, input: MonitorInput, actor: Actor, auto?: { key: string }): Promise<MonitorRow> {
  const kind = MONITOR_KINDS.find((k) => k === input.kind);
  if (!kind) throw new AppError('VALIDATION', 'Unbekannte Art des Monitors');
  const projectId = typeof input.project_id === 'string' && input.project_id ? input.project_id : null;
  if (projectId) {
    if (!ctx.db.get('SELECT 1 AS x FROM projects WHERE id = ? AND deleted_at IS NULL', projectId)) throw new AppError('NOT_FOUND', 'Projekt nicht gefunden');
  } else if (!actor.isAdmin) throw new AppError('FORBIDDEN', 'System-Monitore (ohne Projekt) darf nur ein Administrator anlegen');
  const name = str(input.name, 120);
  if (!name) throw new AppError('VALIDATION', 'Name fehlt');
  const environment = MONITOR_ENVIRONMENTS.find((e) => e === input.environment) ?? 'prod';
  const machine = machineFor(ctx, kind, input.machine_id, isAgentBound({ kind, machine_id: input.machine_id ? String(input.machine_id) : null }));
  const config = normalizeConfig(ctx, kind, input.config, { projectId, machineId: machine?.id ?? null });
  const host = targetHost(kind, config);
  // Prüfungen vom Server aus dürfen keine privaten Ziele treffen (außer ein Administrator legt sie an); auf einer Maschine sind lokale Ziele ausdrücklich gewollt
  if (host && !machine && !actor.isAdmin) await assertPublicTarget(host);
  const id = randomUUID();
  const now = new Date().toISOString();
  const interval = Math.max(MIN_INTERVAL, int(input.interval_seconds, MIN_INTERVAL, 86_400, DEFAULT_INTERVAL[kind]));
  ctx.db.run(
    `INSERT INTO monitors (id, project_id, name, kind, environment, group_label, config_json, machine_id, interval_seconds, enabled, severity_cap, allow_private, auto_key,
                           status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`,
    id, projectId, name, kind, environment, str(input.group, 60) ?? null, JSON.stringify(config), machine?.id ?? null, interval,
    input.enabled === false ? 0 : 1, input.severity_cap === 'warn' ? 'warn' : 'error', actor.isAdmin ? 1 : 0, auto?.key ?? null, actor.id, now, now,
  );
  audit(ctx.db, {
    actor_type: actor.id ? 'user' : 'system', actor_id: actor.id, actor_label: actor.label, action: 'monitor.create', project_id: projectId ?? undefined,
    machine_id: machine?.id ?? undefined, target_type: 'monitor', target_id: id, result: 'success', detail: { name, kind, environment }, ip: actor.ip ?? undefined,
  });
  return getMonitor(ctx, id)!;
}

export function getMonitor(ctx: AppContext, id: string): MonitorRow | undefined {
  return ctx.db.get<MonitorRow>('SELECT * FROM monitors WHERE id = ?', id);
}

export async function updateMonitor(ctx: AppContext, id: string, input: MonitorInput, actor: Actor): Promise<MonitorRow> {
  const row = getMonitor(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', 'Monitor nicht gefunden');
  const kind = row.kind; // die Art ändert sich nicht
  const machine = machineFor(ctx, kind, input.machine_id === undefined ? row.machine_id : input.machine_id, input.machine_id !== undefined && isAgentBound({ kind, machine_id: String(input.machine_id ?? '') || null }));
  const config = input.config === undefined ? parse<Record<string, unknown>>(row.config_json, {}) : normalizeConfig(ctx, kind, input.config, { projectId: row.project_id, machineId: machine?.id ?? null });
  const host = input.config === undefined && input.machine_id === undefined ? null : targetHost(kind, config);
  if (host && !machine && !actor.isAdmin && !row.allow_private) await assertPublicTarget(host);
  const name = input.name === undefined ? row.name : str(input.name, 120);
  if (!name) throw new AppError('VALIDATION', 'Name fehlt');
  ctx.db.run(
    `UPDATE monitors SET name = ?, environment = ?, group_label = ?, config_json = ?, machine_id = ?, interval_seconds = ?, enabled = ?, severity_cap = ?, updated_at = ? WHERE id = ?`,
    name,
    input.environment === undefined ? row.environment : (MONITOR_ENVIRONMENTS.find((e) => e === input.environment) ?? row.environment),
    input.group === undefined ? row.group_label : (str(input.group, 60) ?? null),
    JSON.stringify(config), machine?.id ?? null,
    input.interval_seconds === undefined ? row.interval_seconds : Math.max(MIN_INTERVAL, int(input.interval_seconds, MIN_INTERVAL, 86_400, row.interval_seconds)),
    input.enabled === undefined ? row.enabled : input.enabled === false ? 0 : 1,
    input.severity_cap === undefined ? row.severity_cap : input.severity_cap === 'warn' ? 'warn' : 'error',
    new Date().toISOString(), id,
  );
  audit(ctx.db, { actor_type: 'user', actor_id: actor.id, actor_label: actor.label, action: 'monitor.update', project_id: row.project_id ?? undefined, target_type: 'monitor', target_id: id, result: 'success', detail: { name }, ip: actor.ip ?? undefined });
  return getMonitor(ctx, id)!;
}

export function deleteMonitor(ctx: AppContext, id: string, actor: Actor): void {
  const row = getMonitor(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', 'Monitor nicht gefunden');
  ctx.db.run('DELETE FROM monitors WHERE id = ?', id);
  audit(ctx.db, { actor_type: 'user', actor_id: actor.id, actor_label: actor.label, action: 'monitor.delete', project_id: row.project_id ?? undefined, target_type: 'monitor', target_id: id, result: 'success', detail: { name: row.name }, ip: actor.ip ?? undefined });
}

// ───────────────────────────── Prüfungen ─────────────────────────────

/** Pause vor dem zweiten Versuch (Tests setzen sie auf 0). */
const retry = { delayMs: 3000 };
export function setRetryDelayForTests(ms: number): void {
  retry.delayMs = ms;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CertInfo {
  days: number | null;
  valid: boolean;
  error?: string;
}

/** Zertifikat einer TLS-Verbindung lesen (auch ein ungültiges, damit der Grund gemeldet werden kann). */
export function readCertificate(host: string, port: number, timeoutMs: number): Promise<CertInfo> {
  return new Promise((resolve) => {
    const bare = host.replace(/^\[|\]$/g, '');
    const socket = tls.connect({ host: bare, port, servername: net.isIP(bare) ? undefined : bare, rejectUnauthorized: false, timeout: timeoutMs });
    const done = (r: CertInfo): void => {
      socket.destroy();
      resolve(r);
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const to = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      done({ days: Number.isNaN(to) ? null : Math.floor((to - Date.now()) / 86_400_000), valid: socket.authorized, error: socket.authorized ? undefined : String(socket.authorizationError ?? 'unbekannt') });
    });
    socket.once('timeout', () => done({ days: null, valid: false, error: 'Zeitüberschreitung beim TLS-Verbindungsaufbau' }));
    socket.once('error', (e) => done({ days: null, valid: false, error: e.message }));
  });
}

function certVerdict(info: CertInfo, warnDays: number): { status: MonitorStatus; message: string } | null {
  if (info.error && !info.valid && info.days === null) return { status: 'error', message: `TLS-Fehler: ${info.error}` };
  if (!info.valid) return { status: 'error', message: `Zertifikat ungültig (${info.error ?? 'unbekannt'})` };
  if (info.days !== null && info.days < 0) return { status: 'error', message: `Zertifikat abgelaufen (vor ${-info.days} Tagen)` };
  if (info.days !== null && info.days < 3) return { status: 'error', message: `Zertifikat läuft in ${info.days} Tagen ab` };
  if (info.days !== null && info.days < warnDays) return { status: 'warn', message: `Zertifikat läuft in ${info.days} Tagen ab` };
  return null;
}

function secretValue(ctx: AppContext, projectId: string | null, name: string, environment: string): string | null {
  if (!projectId || !ctx.vault) return null;
  const row = ctx.db.get<{ vault_reference: string }>('SELECT vault_reference FROM secrets WHERE project_id = ? AND name = ? AND environment = ?', projectId, name, environment);
  if (!row) return null;
  try {
    return ctx.vault.getString(row.vault_reference);
  } catch {
    return null;
  }
}

/** HTTP-Prüfung: Statuscode, Antwortzeit, optional Textinhalt/JSON-Zeilen und Zertifikat. Zwei Versuche bei Netzfehler oder 5xx, damit kurze Aussetzer nichts auslösen. */
export async function httpCheck(ctx: AppContext, m: Pick<MonitorRow, 'project_id' | 'allow_private' | 'details_json'>, cfg: Record<string, any>, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  const url = new URL(String(cfg.url));
  if (!m.allow_private) {
    try {
      await assertPublicTarget(url.hostname);
    } catch (e) {
      return { status: 'error', latency_ms: null, message: e instanceof Error ? e.message : 'Ziel nicht erlaubt' };
    }
  }
  const headers: Record<string, string> = { 'User-Agent': 'DevDeck-Monitoring/1' };
  for (const h of (cfg.headers ?? []) as Array<{ name: string; value?: string; secret?: { name: string; environment: string } }>) {
    if (h.secret) {
      const v = secretValue(ctx, m.project_id, h.secret.name, h.secret.environment);
      if (v === null) return { status: 'error', latency_ms: null, message: `Secret ${h.secret.name} (${h.secret.environment}) fehlt im Vault` };
      headers[h.name] = v;
    } else if (h.value !== undefined) headers[h.name] = h.value;
  }
  if (cfg.method === 'POST' && cfg.body) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  const timeout = Number(cfg.timeout_ms ?? 10_000);
  const needBody = Boolean(cfg.contains) || cfg.json_array_min !== undefined;

  let last: CheckResult = { status: 'error', latency_ms: null, message: 'keine Antwort' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await sleep(retry.delayMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const started = Date.now();
    try {
      const res = await fetchImpl(url, { method: cfg.method ?? 'GET', headers, body: cfg.method === 'POST' ? cfg.body : undefined, signal: ctl.signal, redirect: 'follow' });
      let text = '';
      if (needBody) text = (await res.text()).slice(0, 1_000_000);
      else await res.body?.cancel().catch(() => undefined);
      const latency = Date.now() - started;
      const verdict = judgeHttp(cfg, { status: res.status, latency_ms: latency, text });
      if (verdict.status === 'error') {
        last = { status: 'error', latency_ms: latency, message: verdict.message };
        if (verdict.retryable) continue;
        return last;
      }
      let status: MonitorStatus = verdict.status;
      let message = verdict.message;
      const details: Record<string, unknown> = {};
      if (url.protocol === 'https:') {
        const prev = parse<{ cert_days?: number | null; cert_checked_at?: string; cert_valid?: boolean; cert_error?: string }>(m.details_json, {});
        let info: CertInfo;
        if (prev.cert_checked_at && Date.now() - Date.parse(prev.cert_checked_at) < 3_600_000 && prev.cert_valid !== undefined) {
          info = { days: prev.cert_days ?? null, valid: prev.cert_valid, error: prev.cert_error };
        } else {
          info = await readCertificate(url.hostname, Number(url.port || 443), 8000);
          details.cert_checked_at = new Date().toISOString();
        }
        details.cert_days = info.days;
        details.cert_valid = info.valid;
        details.cert_error = info.error;
        const v = certVerdict(info, Number(cfg.cert_warn_days ?? 14));
        if (v && (v.status === 'error' || status === 'ok')) {
          status = v.status;
          message = `${v.message} · ${message}`;
        }
        if (details.cert_checked_at === undefined && prev.cert_checked_at) details.cert_checked_at = prev.cert_checked_at;
      }
      return { status, latency_ms: latency, message, details };
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      last = { status: 'error', latency_ms: null, message: aborted ? `Zeitüberschreitung (${Math.round(timeout / 1000)} s)` : `Netzfehler (${code ?? (err instanceof Error ? err.message : 'unbekannt')})` };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** TCP-Prüfung (z. B. Mail-Server, Datenbank-Port), optional mit TLS-Handshake und Zertifikatsprüfung. */
export async function tcpCheck(ctx: AppContext, m: Pick<MonitorRow, 'allow_private'>, cfg: Record<string, any>): Promise<CheckResult> {
  const host = String(cfg.host);
  if (!m.allow_private) {
    try {
      await assertPublicTarget(host);
    } catch (e) {
      return { status: 'error', latency_ms: null, message: e instanceof Error ? e.message : 'Ziel nicht erlaubt' };
    }
  }
  const port = Number(cfg.port);
  const timeout = Number(cfg.timeout_ms ?? 8000);
  let last: CheckResult = { status: 'error', latency_ms: null, message: 'keine Verbindung' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await sleep(retry.delayMs);
    const started = Date.now();
    const r = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const s = net.createConnection({ host: host.replace(/^\[|\]$/g, ''), port, timeout });
      s.once('connect', () => {
        s.destroy();
        resolve({ ok: true, message: '' });
      });
      s.once('timeout', () => {
        s.destroy();
        resolve({ ok: false, message: `Zeitüberschreitung (${Math.round(timeout / 1000)} s)` });
      });
      s.once('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, message: `Verbindung fehlgeschlagen (${e.code ?? e.message})` }));
    });
    const latency = Date.now() - started;
    if (!r.ok) {
      last = { status: 'error', latency_ms: latency, message: r.message };
      continue;
    }
    let status: MonitorStatus = 'ok';
    let message = `Port ${port} erreichbar, ${latency} ms`;
    if (latency > Number(cfg.warn_latency_ms ?? 3000)) {
      status = 'warn';
      message = `Port ${port} langsam: ${latency} ms`;
    }
    const details: Record<string, unknown> = {};
    if (cfg.tls === true) {
      const info = await readCertificate(host, port, timeout);
      details.cert_days = info.days;
      details.cert_valid = info.valid;
      const v = certVerdict(info, Number(cfg.cert_warn_days ?? 14));
      if (v && (v.status === 'error' || status === 'ok')) {
        status = v.status;
        message = `${v.message} · ${message}`;
      }
    }
    return { status, latency_ms: latency, message, details };
  }
  return last;
}

// ───────────────────────────── Interne Prüfungen (aus den Daten von DevDeck) ─────────────────────────────

const ago = (iso: string | null): string => {
  if (!iso) return 'unbekannt';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} Tagen`;
};

export function internalCheck(ctx: AppContext, m: MonitorRow): CheckResult {
  const cfg = parse<Record<string, any>>(m.config_json, {});
  const { db } = ctx;
  switch (m.kind) {
    case 'machine': {
      const row = db.get<{ name: string; agent_status: string; agent_version: string | null; last_seen_at: string | null; revoked_at: string | null }>('SELECT name, agent_status, agent_version, last_seen_at, revoked_at FROM machines WHERE id = ?', m.machine_id);
      if (!row) return { status: 'error', latency_ms: null, message: 'Maschine ist nicht mehr eingetragen' };
      if (row.revoked_at) return { status: 'error', latency_ms: null, message: 'Maschine wurde widerrufen' };
      if (row.agent_status !== 'online') return { status: 'error', latency_ms: null, message: `„${row.name}“ ist offline (zuletzt gesehen vor ${ago(row.last_seen_at)})` };
      return { status: 'ok', latency_ms: null, message: `online, Agent ${row.agent_version ?? '?'}` };
    }
    case 'disk': {
      const row = db.get<{ inventory_json: string | null }>('SELECT inventory_json FROM machines WHERE id = ?', m.machine_id);
      const inv = parse<{ disks?: Array<{ name: string; total_gb: number; free_gb: number }> } | null>(row?.inventory_json, null);
      const disks = (inv?.disks ?? []).filter((d) => d.total_gb > 0);
      if (!disks.length) return { status: 'unknown', latency_ms: null, message: 'Noch kein Inventar der Maschine (Datenträger)' };
      const worst = disks.map((d) => ({ name: d.name, free: (d.free_gb / d.total_gb) * 100, gb: d.free_gb })).sort((a, b) => a.free - b.free)[0]!;
      const text = `${Math.round(worst.free)} % frei auf ${worst.name} (${Math.round(worst.gb)} GB)`;
      return { status: worst.free < cfg.error_free_pct ? 'error' : worst.free < cfg.warn_free_pct ? 'warn' : 'ok', latency_ms: null, message: text };
    }
    case 'patches': {
      const row = db.get<{ patches_json: string | null }>('SELECT patches_json FROM machines WHERE id = ?', m.machine_id);
      const p = parse<{ security?: number; critical?: number; total?: number; reboot_required?: boolean | null } | null>(row?.patches_json, null);
      if (!p) return { status: 'unknown', latency_ms: null, message: 'Noch kein Patch-Stand der Maschine' };
      if ((p.critical ?? 0) > 0) return { status: 'error', latency_ms: null, message: `${p.critical} kritische Updates ausstehend` };
      if ((p.security ?? 0) > 0) return { status: 'warn', latency_ms: null, message: `${p.security} sicherheitsrelevante Updates ausstehend` };
      if (p.reboot_required) return { status: 'warn', latency_ms: null, message: 'Neustart erforderlich' };
      return { status: 'ok', latency_ms: null, message: p.total ? `${p.total} normale Updates ausstehend` : 'Maschine ist aktuell' };
    }
    case 'backup': {
      const latest = cfg.target === 'system'
        ? db.get<{ at: string }>(`SELECT created_at AS at FROM backups WHERE kind = 'system' AND status = 'success' ORDER BY created_at DESC LIMIT 1`)
        : db.get<{ at: string }>(`SELECT created_at AS at FROM project_backups WHERE job_id = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1`, cfg.target);
      const failed = cfg.target === 'system'
        ? db.get<{ error: string | null; at: string }>(`SELECT error, created_at AS at FROM backups WHERE kind = 'system' AND status = 'failed' ORDER BY created_at DESC LIMIT 1`)
        : db.get<{ error: string | null; at: string }>(`SELECT error, created_at AS at FROM project_backups WHERE job_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`, cfg.target);
      if (!latest) return { status: 'warn', latency_ms: null, message: 'Noch kein erfolgreiches Backup vorhanden' };
      const hours = (Date.now() - Date.parse(latest.at)) / 3_600_000;
      const age = `letztes Backup vor ${ago(latest.at)}`;
      if (hours > cfg.error_hours) return { status: 'error', latency_ms: null, message: `Kein aktuelles Backup – ${age}` };
      if (hours > cfg.warn_hours) return { status: 'warn', latency_ms: null, message: `Backup überfällig – ${age}` };
      if (failed && Date.parse(failed.at) > Date.parse(latest.at)) return { status: 'warn', latency_ms: null, message: `Letzter Lauf fehlgeschlagen (${(failed.error ?? '').slice(0, 120)}) – ${age}` };
      return { status: 'ok', latency_ms: null, message: age };
    }
    case 'replica': {
      const row = getReplica(ctx, cfg.target === 'system' ? 'system' : 'job', cfg.target === 'system' ? null : cfg.target);
      if (!row) return { status: 'unknown', latency_ms: null, message: 'Keine Replik eingerichtet' };
      if (!row.enabled) return { status: 'warn', latency_ms: null, message: 'Replik ist pausiert' };
      if (row.last_ok === 0) return { status: 'error', latency_ms: null, message: row.last_message ?? 'Abgleich fehlgeschlagen' };
      if (row.last_ok === null) return { status: 'warn', latency_ms: null, message: row.last_message ?? 'Noch kein Abgleich abgeschlossen' };
      const stale = row.last_sync_at ? (Date.now() - Date.parse(row.last_sync_at)) / 3_600_000 : Infinity;
      if (stale > 26) return { status: 'warn', latency_ms: null, message: `Letzter Abgleich vor ${ago(row.last_sync_at)}` };
      return { status: 'ok', latency_ms: null, message: row.last_message ?? 'synchron' };
    }
    case 'connector': {
      const row = db.get<{ name: string; last_check_ok: number | null; last_check_message: string | null; last_check_at: string | null }>('SELECT name, last_check_ok, last_check_message, last_check_at FROM project_connectors WHERE id = ?', cfg.connector_id);
      if (!row) return { status: 'error', latency_ms: null, message: 'Integration ist nicht mehr vorhanden' };
      if (row.last_check_ok === null) return { status: 'unknown', latency_ms: null, message: 'Integration wurde noch nicht geprüft' };
      return row.last_check_ok === 1 ? { status: 'ok', latency_ms: null, message: row.last_check_message ?? 'in Ordnung' } : { status: 'error', latency_ms: null, message: row.last_check_message ?? 'Prüfung fehlgeschlagen' };
    }
    default:
      return { status: 'unknown', latency_ms: null, message: 'wird auf der Maschine geprüft' };
  }
}

// ───────────────────────────── Ergebnis übernehmen, Lauf, Verlauf ─────────────────────────────

export function applyResult(ctx: AppContext, id: string, r: CheckResult, at = new Date()): void {
  const row = getMonitor(ctx, id);
  if (!row) return;
  const iso = at.toISOString();
  const prevDetails = parse<Record<string, unknown>>(row.details_json, {});
  const details = { ...prevDetails, ...(r.details ?? {}) };
  ctx.db.run(
    `UPDATE monitors SET status = ?, status_since = CASE WHEN status <> ? OR status_since IS NULL THEN ? ELSE status_since END,
       last_checked_at = ?, last_latency_ms = ?, last_message = ?, details_json = ? WHERE id = ?`,
    r.status, r.status, iso, iso, r.latency_ms, r.message.slice(0, 500), JSON.stringify(details), id,
  );
  if (r.status !== 'unknown') {
    ctx.db.run('INSERT INTO monitor_checks (monitor_id, checked_at, status, latency_ms, message) VALUES (?, ?, ?, ?, ?)', id, iso, r.status, r.latency_ms, r.message.slice(0, 300));
  }
}

export function pruneChecks(ctx: AppContext): void {
  const cutoff = new Date(Date.now() - KEEP_CHECKS_DAYS * 86_400_000).toISOString();
  ctx.db.run('DELETE FROM monitor_checks WHERE checked_at < ?', cutoff);
  ctx.db.run(
    `DELETE FROM monitor_checks WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC) AS rn FROM monitor_checks) WHERE rn > ?)`,
    KEEP_CHECKS_MAX,
  );
}

export async function runOne(ctx: AppContext, m: MonitorRow, fetchImpl?: typeof fetch): Promise<CheckResult> {
  const cfg = parse<Record<string, any>>(m.config_json, {});
  try {
    if (m.kind === 'http') return await httpCheck(ctx, m, cfg, fetchImpl);
    if (m.kind === 'tcp') return await tcpCheck(ctx, m, cfg);
    return internalCheck(ctx, m);
  } catch (err) {
    return { status: 'error', latency_ms: null, message: `Prüfung fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}` };
  }
}

let lastPrune = 0;

/** Zeitplan-Tick (alle ~20 s): fällige Monitore prüfen; Agent-Monitore ohne Rückmeldung auf „unbekannt“ setzen. */
export async function runMonitorTick(ctx: AppContext, now = Date.now(), fetchImpl?: typeof fetch): Promise<number> {
  const rows = ctx.db.all<MonitorRow>(
    `SELECT * FROM monitors WHERE enabled = 1 AND (project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL))`,
  );
  const due = rows.filter((r) => !r.last_checked_at || now - Date.parse(r.last_checked_at) >= r.interval_seconds * 1000 - 1000);
  const local = due.filter((r) => !isAgentBound(r));
  let done = 0;
  const queue = [...local];
  const worker = async (): Promise<void> => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      applyResult(ctx, m.id, await runOne(ctx, m, fetchImpl));
      done += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  // Agent-Monitore: kommt längere Zeit nichts mehr von der Maschine, ist der Zustand unbekannt (Ursache zeigt der Monitor „Maschine online“)
  for (const r of rows.filter(isAgentBound)) {
    const ref = r.last_checked_at ?? r.created_at;
    if (r.status !== 'unknown' && now - Date.parse(ref) > Math.max(r.interval_seconds * 3000, 600_000)) {
      applyResult(ctx, r.id, { status: 'unknown', latency_ms: null, message: 'Keine Rückmeldung von der Maschine (offline oder Agent beendet)' });
    }
  }
  if (now - lastPrune > 3_600_000) {
    lastPrune = now;
    try {
      pruneChecks(ctx);
    } catch {
      /* Aufräumen ist nie wichtig genug, den Lauf zu stoppen */
    }
  }
  return done;
}

// ───────────────────────────── Agent (Heartbeat) ─────────────────────────────

/** Prüfaufträge für die Maschine (in der Heartbeat-Antwort). */
export function probesFor(ctx: AppContext, machineId: string): ProbeSpec[] {
  const rows = ctx.db.all<MonitorRow>(
    `SELECT * FROM monitors WHERE enabled = 1 AND machine_id = ? AND kind IN ('http', 'tcp', 'systemd')
       AND (project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL))`,
    machineId,
  );
  return rows.map((r) => {
    const cfg = parse<Record<string, unknown>>(r.config_json, {});
    // Zugangsdaten (Secrets) werden dem Agenten nie übergeben: http mit Secret-Header läuft nur auf dem Server
    const headers = ((cfg.headers ?? []) as Array<{ name: string; value?: string; secret?: unknown }>).filter((h) => !h.secret);
    return { id: r.id, kind: r.kind as 'http' | 'tcp' | 'systemd', config: { ...cfg, ...(cfg.headers ? { headers } : {}) }, interval_seconds: r.interval_seconds, force: r.force_token };
  });
}

/** Ergebnisse einer Maschine übernehmen; nur für Monitore, die dieser Maschine zugeordnet sind. */
export function ingestProbeResults(ctx: AppContext, machine: { id: string }, raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let n = 0;
  for (const item of raw.slice(0, 200)) {
    const r = (item ?? {}) as Partial<ProbeResult>;
    if (typeof r.id !== 'string') continue;
    const row = getMonitor(ctx, r.id);
    if (!row || row.machine_id !== machine.id || !isAgentBound(row)) continue;
    const status: MonitorStatus = r.status === 'ok' || r.status === 'warn' || r.status === 'error' ? r.status : 'error';
    const at = typeof r.checked_at === 'string' && !Number.isNaN(Date.parse(r.checked_at)) && Date.parse(r.checked_at) <= Date.now() + 60_000 ? new Date(r.checked_at) : new Date();
    applyResult(ctx, row.id, { status, latency_ms: typeof r.latency_ms === 'number' && r.latency_ms >= 0 ? Math.round(r.latency_ms) : null, message: String(r.message ?? '').slice(0, 300) || (status === 'ok' ? 'in Ordnung' : 'Fehler') }, at);
    n += 1;
  }
  return n;
}

/** „Jetzt prüfen“: Server-Monitore sofort, Agent-Monitore beim nächsten Heartbeat (neuer force-Wert). */
export async function checkNow(ctx: AppContext, id: string, fetchImpl?: typeof fetch): Promise<MonitorRow> {
  const m = getMonitor(ctx, id);
  if (!m) throw new AppError('NOT_FOUND', 'Monitor nicht gefunden');
  if (isAgentBound(m)) ctx.db.run('UPDATE monitors SET force_token = ? WHERE id = ?', randomUUID(), id);
  else applyResult(ctx, id, await runOne(ctx, m, fetchImpl));
  return getMonitor(ctx, id)!;
}

// ───────────────────────────── Ausgabe ─────────────────────────────

export interface MonitorDto {
  id: string;
  project: { id: string; name: string } | null;
  name: string;
  kind: MonitorKind;
  environment: 'prod' | 'dev';
  group: string | null;
  target: string;
  config: Record<string, unknown>;
  machine: { id: string; name: string; platform: string } | null;
  interval_seconds: number;
  enabled: boolean;
  severity_cap: 'error' | 'warn';
  status: MonitorStatus;
  /** Status, wie er in die Projekt-Ampel eingeht (Entwicklung/Obergrenze berücksichtigt) */
  effective_status: MonitorStatus;
  status_since: string | null;
  last_checked_at: string | null;
  latency_ms: number | null;
  message: string | null;
  details: Record<string, unknown>;
  uptime_24h: number | null;
  history: Array<{ at: string; status: MonitorStatus; latency_ms: number | null }>;
  auto: boolean;
  agent_bound: boolean;
}

function describeTarget(m: MonitorRow, cfg: Record<string, any>, machineName: string | null): string {
  switch (m.kind) {
    case 'http': return `${cfg.method && cfg.method !== 'GET' ? `${cfg.method} ` : ''}${cfg.url}${machineName ? ` (von ${machineName})` : ''}`;
    case 'tcp': return `${cfg.host}:${cfg.port}${cfg.tls ? ' (TLS)' : ''}${machineName ? ` (von ${machineName})` : ''}`;
    case 'systemd': return `${cfg.scope === 'system' ? 'Dienst' : 'Benutzerdienst'} ${cfg.unit}${machineName ? ` auf ${machineName}` : ''}`;
    case 'machine': return `Maschine ${machineName ?? '?'}`;
    case 'disk': return `Datenträger auf ${machineName ?? '?'}`;
    case 'patches': return `Updates auf ${machineName ?? '?'}`;
    case 'backup': return cfg.target === 'system' ? 'System-Backups von DevDeck' : 'Backup-Job des Projekts';
    case 'replica': return cfg.target === 'system' ? 'Replik der System-Backups' : 'Replik des Backup-Jobs';
    default: return 'Integration';
  }
}

/** Header-Werte nie ausgeben: nur Name (und bei Secrets der Secret-Name). */
function publicConfig(cfg: Record<string, any>): Record<string, unknown> {
  if (!Array.isArray(cfg.headers)) return cfg;
  return { ...cfg, headers: cfg.headers.map((h: { name: string; value?: string; secret?: { name: string } }) => (h.secret ? { name: h.name, secret: h.secret } : { name: h.name, value: '••••' })) };
}

export function monitorDtos(ctx: AppContext, rows: MonitorRow[]): MonitorDto[] {
  if (!rows.length) return [];
  const machines = new Map(ctx.db.all<{ id: string; name: string; platform: string }>('SELECT id, name, platform FROM machines').map((m) => [m.id, m]));
  const projects = new Map(ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM projects').map((p) => [p.id, p]));
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return rows.map((m) => {
    const cfg = parse<Record<string, unknown>>(m.config_json, {});
    const mach = m.machine_id ? machines.get(m.machine_id) ?? null : null;
    const history = ctx.db.all<{ checked_at: string; status: MonitorStatus; latency_ms: number | null }>(
      'SELECT checked_at, status, latency_ms FROM monitor_checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 48', m.id,
    ).reverse();
    const day = ctx.db.get<{ total: number; bad: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'error'), 0) AS bad FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ?`, m.id, since,
    );
    const effective: MonitorStatus = m.status === 'error' && (m.severity_cap === 'warn' || m.environment !== 'prod') ? 'warn' : m.status;
    return {
      id: m.id,
      project: m.project_id ? projects.get(m.project_id) ?? null : null,
      name: m.name, kind: m.kind, environment: m.environment, group: m.group_label,
      target: describeTarget(m, cfg, mach?.name ?? null),
      config: publicConfig(cfg), machine: mach,
      interval_seconds: m.interval_seconds, enabled: m.enabled === 1, severity_cap: m.severity_cap,
      status: m.status, effective_status: m.enabled === 1 ? effective : 'unknown', status_since: m.status_since, last_checked_at: m.last_checked_at,
      latency_ms: m.last_latency_ms, message: m.last_message, details: parse<Record<string, unknown>>(m.details_json, {}),
      uptime_24h: day && day.total > 0 ? Math.round(((day.total - day.bad) / day.total) * 1000) / 10 : null,
      history: history.map((h) => ({ at: h.checked_at, status: h.status, latency_ms: h.latency_ms })),
      auto: m.auto_key !== null, agent_bound: isAgentBound(m),
    };
  });
}

/** Sichtbare Monitore: Admin alle, sonst die der eigenen Projekte (System-Monitore nur für Admins). */
export function visibleMonitors(ctx: AppContext, user: { id: string; system_role: string }, projectId?: string | null): MonitorRow[] {
  const alive = '(m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL))';
  const scope = user.system_role === 'admin' ? '' : 'AND m.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)';
  const filter = projectId ? 'AND m.project_id = ?' : '';
  const params: unknown[] = [...(user.system_role === 'admin' ? [] : [user.id]), ...(projectId ? [projectId] : [])];
  return ctx.db.all<MonitorRow>(`SELECT m.* FROM monitors m WHERE ${alive} ${scope} ${filter} ORDER BY (m.project_id IS NULL), m.environment DESC, m.group_label, m.name`, ...params);
}

export interface ProjectMonitoring {
  status: MonitorStatus | 'none';
  total: number;
  ok: number;
  warn: number;
  error: number;
  unknown: number;
}

/** Ampel je Projekt für die Projektübersicht. */
export function projectMonitoring(ctx: AppContext, projectIds: string[]): Map<string, ProjectMonitoring> {
  const out = new Map<string, ProjectMonitoring>();
  if (!projectIds.length) return out;
  const rows = ctx.db.all<Pick<MonitorRow, 'project_id' | 'status' | 'environment' | 'enabled' | 'severity_cap'>>(
    `SELECT project_id, status, environment, enabled, severity_cap FROM monitors WHERE project_id IN (${projectIds.map(() => '?').join(',')})`, ...projectIds,
  );
  for (const id of projectIds) {
    const mine = rows.filter((r) => r.project_id === id && r.enabled === 1);
    if (!mine.length) {
      out.set(id, { status: 'none', total: 0, ok: 0, warn: 0, error: 0, unknown: 0 });
      continue;
    }
    const eff = mine.map((m) => ({ ...m, enabled: true }));
    const count = (s: MonitorStatus): number => eff.filter((m) => (m.status === 'error' && (m.severity_cap === 'warn' || m.environment !== 'prod') ? 'warn' : m.status) === s).length;
    out.set(id, { status: projectStatus(eff), total: mine.length, ok: count('ok'), warn: count('warn'), error: count('error'), unknown: count('unknown') });
  }
  return out;
}

export { worstStatus };
