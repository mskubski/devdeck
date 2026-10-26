import { createHash, randomUUID } from 'node:crypto';
import { AppError, type GithubIssueRef } from '@devdeck/shared';
import type { Database } from '../db/database.js';
import type { AppContext } from '../context.js';
import { audit } from './audit.js';

/**
 * Zwei-Wege-Abgleich zwischen DevDeck (Tasks, Known Issues) und GitHub Issues.
 *
 * Zuordnung: Tasks ↔ Issues ohne Kennzeichnung; Known Issues ↔ Issues mit dem Label `bug` oder `known-issue`.
 * DevDeck verwaltet nur diese Labels (alles andere an den Issues bleibt unberührt):
 *   Tasks: `P1`–`P5` (Priorität), `in-progress` (in Arbeit)   Known Issues: `known-issue`, `severity-low|medium|high`
 * Status: offen ↔ open · in Arbeit ↔ open + `in-progress` · erledigt ↔ closed (completed) · verworfen ↔ closed (not_planned);
 * Known Issue: offen ↔ open · gelöst ↔ closed.
 *
 * Änderungserkennung über einen Hash der abgeglichenen Felder beim letzten Abgleich (`synced_hash`): Ändert sich nur eine Seite,
 * wird sie übernommen; ändern sich beide, gewinnt GitHub (Konflikt wird gezählt).
 */

const API = 'https://api.github.com';
/** Höchstzahl neu anzulegender GitHub-Issues je Durchlauf (schont Rate-Limits; der Rest folgt im nächsten Lauf). */
export const MAX_CREATE_PER_RUN = 50;
const MAX_PAGES = 10;

const KNOWN_ISSUE_LABELS = ['bug', 'known-issue'];
const MANAGED_TASK = /^(p[1-5]|in-progress)$/i;
const MANAGED_KNOWN = /^(known-issue|severity-(low|medium|high))$/i;

type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
type Severity = 'low' | 'medium' | 'high';
export type LinkKind = 'task' | 'known_issue';

export interface RemoteIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  created_at: string;
  updated_at: string;
  html_url?: string;
}

interface TaskCanon { title: string; body: string; status: TaskStatus; priority: number }
interface KnownCanon { title: string; body: string; status: 'open' | 'resolved'; severity: Severity }

export interface IssueSyncResult {
  ok: boolean;
  message: string;
  created_local: number;
  updated_local: number;
  created_remote: number;
  updated_remote: number;
  conflicts: number;
  errors: string[];
  pending: number;
}

const norm = (v: unknown): string => String(v ?? '').replace(/\r\n/g, '\n').trim();
const hash = (v: unknown): string => createHash('sha1').update(JSON.stringify(v)).digest('hex');
const has = (labels: string[], name: string): boolean => labels.some((l) => l.toLowerCase() === name);

/** Priorität 1–5 aus einem Label `P3`; sonst null. */
const priorityOf = (labels: string[]): number | null => {
  for (const l of labels) {
    const m = /^p([1-5])$/i.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
};
const severityOf = (labels: string[]): Severity => {
  for (const l of labels) {
    const m = /^severity-(low|medium|high)$/i.exec(l);
    if (m) return m[1]!.toLowerCase() as Severity;
  }
  return 'medium';
};
export const isKnownIssueIssue = (labels: string[]): boolean => KNOWN_ISSUE_LABELS.some((n) => has(labels, n));

export function taskFromRemote(i: RemoteIssue, fallbackPriority: number): TaskCanon {
  const status: TaskStatus = i.state === 'open' ? (has(i.labels, 'in-progress') ? 'in_progress' : 'open') : i.state_reason === 'not_planned' ? 'cancelled' : 'done';
  return { title: norm(i.title), body: norm(i.body), status, priority: priorityOf(i.labels) ?? fallbackPriority };
}
export function knownFromRemote(i: RemoteIssue): KnownCanon {
  return { title: norm(i.title), body: norm(i.body), status: i.state === 'open' ? 'open' : 'resolved', severity: severityOf(i.labels) };
}

/** Felder, die DevDeck an GitHub schickt: Titel, Text, Zustand und die verwalteten Labels (fremde Labels bleiben erhalten). */
export function remoteFromTask(t: TaskCanon, currentLabels: string[]): { title: string; body: string; state: 'open' | 'closed'; state_reason: string; labels: string[] } {
  const keep = currentLabels.filter((l) => !MANAGED_TASK.test(l));
  const labels = [...keep];
  if (t.priority >= 1 && t.priority <= 5) labels.push(`P${t.priority}`);
  if (t.status === 'in_progress') labels.push('in-progress');
  const open = t.status === 'open' || t.status === 'in_progress';
  return { title: t.title, body: t.body, state: open ? 'open' : 'closed', state_reason: open ? 'reopened' : t.status === 'cancelled' ? 'not_planned' : 'completed', labels };
}
export function remoteFromKnown(k: KnownCanon, currentLabels: string[]): { title: string; body: string; state: 'open' | 'closed'; state_reason: string; labels: string[] } {
  const keep = currentLabels.filter((l) => !MANAGED_KNOWN.test(l));
  const labels = [...keep, 'known-issue', `severity-${k.severity}`];
  return { title: k.title, body: k.body, state: k.status === 'open' ? 'open' : 'closed', state_reason: k.status === 'open' ? 'reopened' : 'completed', labels };
}

// ───────────────────────────── GitHub-Client ─────────────────────────────

class GitHub {
  constructor(private readonly repo: string, private readonly token: string, private readonly doFetch: typeof fetch) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'devdeck', ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError('INTERNAL', 'GitHub nicht erreichbar');
    }
    if (res.status === 401) throw new AppError('UNAUTHORIZED', 'GitHub-Token ungültig oder abgelaufen');
    if (res.status === 403 || res.status === 429) {
      const text = await res.text().catch(() => '');
      throw new AppError('FORBIDDEN', /rate limit/i.test(text) ? 'GitHub-Rate-Limit erreicht – der nächste Lauf versucht es erneut' : 'Das GitHub-Token darf Issues nicht lesen/schreiben (Berechtigung „Issues: Read and write“ nötig)');
    }
    if (res.status === 404) throw new AppError('NOT_FOUND', `Repository ${this.repo} oder Issue nicht gefunden (oder kein Zugriff)`);
    if (res.status === 410) throw new AppError('NOT_FOUND', 'Issues sind in diesem Repository deaktiviert');
    if (!res.ok) throw new AppError('INTERNAL', `GitHub antwortete mit HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  private static toIssue(raw: Record<string, any>): RemoteIssue {
    return {
      number: Number(raw.number), title: String(raw.title ?? ''), body: typeof raw.body === 'string' ? raw.body : null,
      state: raw.state === 'closed' ? 'closed' : 'open', state_reason: typeof raw.state_reason === 'string' ? raw.state_reason : null,
      labels: (Array.isArray(raw.labels) ? raw.labels : []).map((l: any) => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean),
      created_at: String(raw.created_at ?? ''), updated_at: String(raw.updated_at ?? ''), html_url: typeof raw.html_url === 'string' ? raw.html_url : undefined,
    };
  }

  /** Alle Issues (ohne Pull Requests), seit `since` verändert, älteste zuerst; `truncated`, wenn die Seitengrenze erreicht wurde. */
  async list(since: string | null): Promise<{ issues: RemoteIssue[]; truncated: boolean }> {
    const issues: RemoteIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = `state=all&sort=updated&direction=asc&per_page=100&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
      const raw = (await this.call('GET', `/repos/${this.repo}/issues?${qs}`)) as Array<Record<string, any>>;
      if (!Array.isArray(raw)) break;
      issues.push(...raw.filter((r) => !r.pull_request).map(GitHub.toIssue));
      if (raw.length < 100) return { issues, truncated: false };
    }
    return { issues, truncated: true };
  }

  async get(n: number): Promise<RemoteIssue> {
    return GitHub.toIssue((await this.call('GET', `/repos/${this.repo}/issues/${n}`)) as Record<string, any>);
  }

  async create(p: { title: string; body: string; labels: string[] }): Promise<RemoteIssue> {
    return GitHub.toIssue((await this.call('POST', `/repos/${this.repo}/issues`, p)) as Record<string, any>);
  }

  async patch(n: number, p: Record<string, unknown>): Promise<RemoteIssue> {
    return GitHub.toIssue((await this.call('PATCH', `/repos/${this.repo}/issues/${n}`, p)) as Record<string, any>);
  }
}

// ───────────────────────────── Datenzugriff ─────────────────────────────

interface TaskRow { id: string; title: string; description: string | null; status: TaskStatus; priority: number }
interface KnownRow { id: string; title: string; description: string | null; status: 'open' | 'resolved'; severity: Severity }
interface LinkRow { id: number; kind: LinkKind; local_id: string; issue_number: number; synced_hash: string; gone: number }
interface ConnectorRow { id: string; project_id: string; type: string; config_json: string; secret_id: string | null; sync_enabled: number }

const taskCanon = (t: TaskRow): TaskCanon => ({ title: norm(t.title), body: norm(t.description), status: t.status, priority: t.priority });
const knownCanon = (k: KnownRow): KnownCanon => ({ title: norm(k.title), body: norm(k.description), status: k.status, severity: k.severity });

const running = new Map<string, Promise<IssueSyncResult>>();
const timers = new Map<string, NodeJS.Timeout>();

function emptyResult(): IssueSyncResult {
  return { ok: true, message: '', created_local: 0, updated_local: 0, created_remote: 0, updated_remote: 0, conflicts: 0, errors: [], pending: 0 };
}

/** Wie viele lokale Einträge hätten noch kein GitHub-Issue (für die Rückfrage beim Aktivieren). */
export function syncPreview(ctx: AppContext, connectorId: string, projectId: string): { unlinked_tasks: number; unlinked_known_issues: number; linked: number } {
  const { db } = ctx;
  const n = (sql: string): number => db.get<{ n: number }>(sql, projectId, connectorId)?.n ?? 0;
  return {
    unlinked_tasks: n(`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND NOT EXISTS (SELECT 1 FROM issue_links l WHERE l.connector_id = ? AND l.kind = 'task' AND l.local_id = t.id)`),
    unlinked_known_issues: n(`SELECT COUNT(*) AS n FROM known_issues k WHERE k.project_id = ? AND NOT EXISTS (SELECT 1 FROM issue_links l WHERE l.connector_id = ? AND l.kind = 'known_issue' AND l.local_id = k.id)`),
    linked: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issue_links WHERE connector_id = ?', connectorId)?.n ?? 0,
  };
}

/** Ein Abgleich-Lauf für einen GitHub-Konnektor. Läuft pro Konnektor höchstens einmal gleichzeitig. */
export function runIssueSync(ctx: AppContext, connectorId: string): Promise<IssueSyncResult> {
  const existing = running.get(connectorId);
  if (existing) return existing;
  const p = doSync(ctx, connectorId).finally(() => running.delete(connectorId));
  running.set(connectorId, p);
  return p;
}

async function doSync(ctx: AppContext, connectorId: string): Promise<IssueSyncResult> {
  const { db } = ctx;
  const result = emptyResult();
  const row = db.get<ConnectorRow>('SELECT id, project_id, type, config_json, secret_id, sync_enabled FROM project_connectors WHERE id = ?', connectorId);
  if (!row || row.type !== 'github') throw new AppError('NOT_FOUND', 'GitHub-Konnektor nicht gefunden');
  const finish = (r: IssueSyncResult, since: string | null | undefined): IssueSyncResult => {
    db.run(
      `UPDATE project_connectors SET sync_last_at = ?, sync_last_ok = ?, sync_last_message = ?, sync_since = COALESCE(?, sync_since) WHERE id = ?`,
      new Date().toISOString(), r.ok ? 1 : 0, r.message.slice(0, 500), since ?? null, connectorId,
    );
    audit(db, {
      actor_type: 'system', actor_label: 'issue-sync', action: 'issue.sync', project_id: row.project_id, target_type: 'connector', target_id: connectorId,
      result: r.ok ? 'success' : 'failure', detail: { ...r, errors: r.errors.slice(0, 3) },
    });
    return r;
  };

  try {
    if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist nicht initialisiert');
    const secret = row.secret_id ? db.get<{ vault_reference: string }>('SELECT vault_reference FROM secrets WHERE id = ?', row.secret_id) : undefined;
    if (!secret || !ctx.vault.has(secret.vault_reference)) throw new AppError('SECRET_UNAVAILABLE', 'Für den Konnektor ist kein Token im Vault hinterlegt');
    const repo = (JSON.parse(row.config_json) as { repo?: string }).repo;
    if (!repo) throw new AppError('VALIDATION', 'Konnektor ohne Repository');
    const gh = new GitHub(repo, ctx.vault.getString(secret.vault_reference), ctx.fetch ?? fetch);
    const since = db.get<{ sync_since: string | null }>('SELECT sync_since FROM project_connectors WHERE id = ?', connectorId)?.sync_since ?? null;
    const startedAt = new Date(Date.now() - 60_000).toISOString(); // eine Minute Überlappung gegen Uhrabweichungen

    const linkBy = (n: number): LinkRow | undefined =>
      db.get<LinkRow>('SELECT id, kind, local_id, issue_number, synced_hash, gone FROM issue_links WHERE connector_id = ? AND issue_number = ?', connectorId, n);
    const saveLink = (kind: LinkKind, localId: string, n: number, h: string, remoteUpdated: string): void => {
      db.run(
        `INSERT INTO issue_links (project_id, connector_id, kind, local_id, issue_number, synced_hash, remote_updated_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (connector_id, issue_number) DO UPDATE SET synced_hash = excluded.synced_hash, remote_updated_at = excluded.remote_updated_at, last_synced_at = excluded.last_synced_at`,
        row.project_id, connectorId, kind, localId, n, h, remoteUpdated, new Date().toISOString(),
      );
    };
    const fetched = new Map<number, RemoteIssue>();
    const now = (): string => new Date().toISOString();

    // ── Phase 1: GitHub → DevDeck ──
    const { issues, truncated } = await gh.list(since);
    for (const issue of issues) {
      fetched.set(issue.number, issue);
      try {
        const link = linkBy(issue.number);
        if (!link) {
          if (isKnownIssueIssue(issue.labels)) {
            const id = randomUUID();
            const k = knownFromRemote(issue);
            db.run(
              `INSERT INTO known_issues (id, project_id, title, description, status, severity, created_by, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
              id, row.project_id, k.title, k.body || null, k.status, k.severity, issue.created_at || now(), k.status === 'resolved' ? issue.updated_at || now() : null,
            );
            saveLink('known_issue', id, issue.number, hash(k), issue.updated_at);
          } else {
            const id = randomUUID();
            const t = taskFromRemote(issue, 3);
            db.run(
              `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
              id, row.project_id, t.title, t.body || null, t.status, t.priority, issue.created_at || now(), now(), t.status === 'done' || t.status === 'cancelled' ? issue.updated_at || now() : null,
            );
            saveLink('task', id, issue.number, hash(t), issue.updated_at);
          }
          result.created_local += 1;
          continue;
        }
        if (link.gone) continue;
        if (link.kind === 'task') {
          const local = db.get<TaskRow>('SELECT id, title, description, status, priority FROM tasks WHERE id = ?', link.local_id);
          if (!local) { db.run('DELETE FROM issue_links WHERE id = ?', link.id); continue; }
          const lh = hash(taskCanon(local));
          const remote = taskFromRemote(issue, local.priority);
          const rh = hash(remote);
          if (rh === link.synced_hash) continue; // GitHub unverändert; lokale Änderungen schiebt Phase 2
          if (lh !== link.synced_hash && lh !== rh) result.conflicts += 1; // beide verändert: GitHub gewinnt
          if (lh !== rh) {
            db.run(
              `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
              remote.title, remote.body || null, remote.status, remote.priority, now(), remote.status === 'done' || remote.status === 'cancelled' ? now() : null, local.id,
            );
            result.updated_local += 1;
          }
          saveLink('task', local.id, issue.number, rh, issue.updated_at);
        } else {
          const local = db.get<KnownRow>('SELECT id, title, description, status, severity FROM known_issues WHERE id = ?', link.local_id);
          if (!local) { db.run('DELETE FROM issue_links WHERE id = ?', link.id); continue; }
          const lh = hash(knownCanon(local));
          const remote = knownFromRemote(issue);
          const rh = hash(remote);
          if (rh === link.synced_hash) continue;
          if (lh !== link.synced_hash && lh !== rh) result.conflicts += 1;
          if (lh !== rh) {
            db.run(
              `UPDATE known_issues SET title = ?, description = ?, status = ?, severity = ?, resolved_at = ? WHERE id = ?`,
              remote.title, remote.body || null, remote.status, remote.severity, remote.status === 'resolved' ? now() : null, local.id,
            );
            result.updated_local += 1;
          }
          saveLink('known_issue', local.id, issue.number, rh, issue.updated_at);
        }
      } catch (err) {
        result.errors.push(`#${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Phase 2: DevDeck → GitHub (lokal veränderte, bereits verknüpfte Einträge) ──
    const links = db.all<LinkRow>('SELECT id, kind, local_id, issue_number, synced_hash, gone FROM issue_links WHERE connector_id = ? AND gone = 0', connectorId);
    for (const link of links) {
      try {
        let canon: TaskCanon | KnownCanon;
        if (link.kind === 'task') {
          const local = db.get<TaskRow>('SELECT id, title, description, status, priority FROM tasks WHERE id = ?', link.local_id);
          if (!local) { db.run('DELETE FROM issue_links WHERE id = ?', link.id); continue; }
          canon = taskCanon(local);
        } else {
          const local = db.get<KnownRow>('SELECT id, title, description, status, severity FROM known_issues WHERE id = ?', link.local_id);
          if (!local) { db.run('DELETE FROM issue_links WHERE id = ?', link.id); continue; }
          canon = knownCanon(local);
        }
        const lh = hash(canon);
        if (lh === link.synced_hash) continue;
        const current = fetched.get(link.issue_number) ?? (await gh.get(link.issue_number));
        const payload = link.kind === 'task' ? remoteFromTask(canon as TaskCanon, current.labels) : remoteFromKnown(canon as KnownCanon, current.labels);
        const body: Record<string, unknown> = { ...payload };
        if (payload.state === 'open' && current.state === 'open') delete body.state_reason; // „reopened“ nur beim tatsächlichen Wiedereröffnen
        const updated = await gh.patch(link.issue_number, body);
        saveLink(link.kind, link.local_id, link.issue_number, lh, updated.updated_at);
        result.updated_remote += 1;
      } catch (err) {
        if (err instanceof AppError && err.code === 'NOT_FOUND') {
          db.run('UPDATE issue_links SET gone = 1 WHERE id = ?', link.id); // Issue auf GitHub gelöscht/übertragen: nicht neu anlegen, lokaler Eintrag bleibt
          result.errors.push(`#${link.issue_number}: auf GitHub nicht mehr vorhanden – Verknüpfung gelöst (der lokale Eintrag bleibt bestehen)`);
        } else {
          result.errors.push(`#${link.issue_number}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── Phase 3: DevDeck → GitHub (neue lokale Einträge ohne Issue) ──
    let budget = MAX_CREATE_PER_RUN;
    const unlinkedTasks = db.all<TaskRow>(
      `SELECT t.id, t.title, t.description, t.status, t.priority FROM tasks t WHERE t.project_id = ? AND NOT EXISTS
         (SELECT 1 FROM issue_links l WHERE l.connector_id = ? AND l.kind = 'task' AND l.local_id = t.id) ORDER BY t.created_at`,
      row.project_id, connectorId,
    );
    const unlinkedKnown = db.all<KnownRow>(
      `SELECT k.id, k.title, k.description, k.status, k.severity FROM known_issues k WHERE k.project_id = ? AND NOT EXISTS
         (SELECT 1 FROM issue_links l WHERE l.connector_id = ? AND l.kind = 'known_issue' AND l.local_id = k.id) ORDER BY k.created_at`,
      row.project_id, connectorId,
    );
    const create = async (kind: LinkKind, localId: string, canon: TaskCanon | KnownCanon): Promise<void> => {
      const payload = kind === 'task' ? remoteFromTask(canon as TaskCanon, []) : remoteFromKnown(canon as KnownCanon, []);
      let issue = await gh.create({ title: payload.title || '(ohne Titel)', body: payload.body, labels: payload.labels });
      if (payload.state === 'closed') issue = await gh.patch(issue.number, { state: 'closed', state_reason: payload.state_reason });
      saveLink(kind, localId, issue.number, hash(canon), issue.updated_at);
      result.created_remote += 1;
    };
    for (const t of unlinkedTasks) {
      if (budget-- <= 0) { result.pending += 1; continue; }
      try { await create('task', t.id, taskCanon(t)); } catch (err) { result.errors.push(`Task „${t.title.slice(0, 40)}“: ${err instanceof Error ? err.message : String(err)}`); }
    }
    for (const k of unlinkedKnown) {
      if (budget-- <= 0) { result.pending += 1; continue; }
      try { await create('known_issue', k.id, knownCanon(k)); } catch (err) { result.errors.push(`Known Issue „${k.title.slice(0, 40)}“: ${err instanceof Error ? err.message : String(err)}`); }
    }

    // Cursor: bei abgeschnittener Liste dort weitermachen, wo sie endete; sonst ab Beginn dieses Laufs
    const nextSince = truncated && issues.length ? issues[issues.length - 1]!.updated_at : startedAt;
    const parts = [
      result.created_local && `${result.created_local} von GitHub übernommen`,
      result.updated_local && `${result.updated_local} lokal aktualisiert`,
      result.created_remote && `${result.created_remote} auf GitHub angelegt`,
      result.updated_remote && `${result.updated_remote} auf GitHub aktualisiert`,
      result.conflicts && `${result.conflicts} Konflikt(e) (GitHub hat Vorrang)`,
      result.pending && `${result.pending} folgen im nächsten Lauf`,
      result.errors.length && `${result.errors.length} Fehler`,
    ].filter(Boolean);
    result.message = parts.length ? parts.join(', ') : 'Alles abgeglichen – keine Änderungen';
    result.ok = result.errors.length === 0;
    return finish(result, nextSince);
  } catch (err) {
    result.ok = false;
    result.message = err instanceof Error ? err.message : String(err);
    return finish(result, undefined);
  }
}

/** Verknüpfte GitHub-Issues an Tasks bzw. Known Issues hängen (für Anzeige und Link in der Oberfläche). */
export function attachIssueRefs<T extends { id: string }>(db: Database, projectId: string, kind: LinkKind, items: T[]): Array<T & { github_issue: GithubIssueRef | null }> {
  const rows = db.all<{ local_id: string; issue_number: number; config_json: string }>(
    `SELECT l.local_id, l.issue_number, c.config_json FROM issue_links l JOIN project_connectors c ON c.id = l.connector_id WHERE l.project_id = ? AND l.kind = ? AND l.gone = 0`,
    projectId, kind,
  );
  const refs = new Map<string, GithubIssueRef>();
  for (const r of rows) {
    try {
      const repo = (JSON.parse(r.config_json) as { repo?: string }).repo;
      if (repo) refs.set(r.local_id, { number: r.issue_number, url: `https://github.com/${repo}/issues/${r.issue_number}` });
    } catch {
      /* defekte Konfiguration: kein Link */
    }
  }
  return items.map((i) => ({ ...i, github_issue: refs.get(i.id) ?? null }));
}

/** Kurz nach einer lokalen Änderung abgleichen (Entprellung, damit mehrere Änderungen in einem Lauf landen). */
export function scheduleIssueSync(ctx: AppContext, projectId: string, delayMs = 5_000): void {
  const connectors = ctx.db.all<{ id: string }>(`SELECT id FROM project_connectors WHERE project_id = ? AND type = 'github' AND sync_enabled = 1`, projectId);
  for (const c of connectors) {
    if (timers.has(c.id)) continue;
    const t = setTimeout(() => {
      timers.delete(c.id);
      runIssueSync(ctx, c.id).catch(() => undefined);
    }, delayMs);
    t.unref?.();
    timers.set(c.id, t);
  }
}

/** Alle aktivierten Konnektoren nacheinander abgleichen (periodisch vom Server aufgerufen). */
export async function runAllIssueSyncs(ctx: AppContext): Promise<void> {
  const connectors = ctx.db.all<{ id: string }>(`SELECT id FROM project_connectors WHERE type = 'github' AND sync_enabled = 1`);
  for (const c of connectors) {
    await runIssueSync(ctx, c.id).catch(() => undefined);
  }
}
