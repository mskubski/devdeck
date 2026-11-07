import type { BackupSchedule } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { buildArchitecture } from './architecture/build.js';
import { createMonitor, type MonitorInput } from './monitoring.js';

/**
 * Vorschläge für Monitore, abgeleitet aus dem, was DevDeck über ein Projekt weiß: Backup-Jobs und Repliken, Integrationen, Supabase-Zugangsdaten im Vault
 * (nur die URL und der öffentliche anon-Schlüssel werden verwendet), Domains und Mail-Server aus der Architektur-Karte. Jeder Vorschlag hat einen stabilen
 * Schlüssel (`auto_key`) – wiederholtes Anlegen erzeugt keine Doppelten.
 */

export interface Suggestion extends MonitorInput {
  auto_key: string;
  reason: string;
}

const parse = <T>(v: string | null | undefined, fallback: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Wie oft ein Backup erwartet wird → ab wann „überfällig“ (Warnung) bzw. „kein aktuelles Backup“ (Fehler). */
function backupThresholds(s: BackupSchedule | null): { warn_hours: number; error_hours: number } | null {
  if (!s || s.mode === 'off') return null;
  if (s.mode === 'weekly') return { warn_hours: 8 * 24, error_hours: 15 * 24 };
  if (s.mode === 'interval') return { warn_hours: Math.max(2, s.every_hours * 2 + 1), error_hours: Math.max(4, s.every_hours * 4 + 2) };
  return { warn_hours: 36, error_hours: 72 };
}

const envOf = (secretEnv: string): 'prod' | 'dev' => (secretEnv === 'production' ? 'prod' : 'dev');

export function suggestMonitors(ctx: AppContext, projectId: string): Suggestion[] {
  const out: Suggestion[] = [];
  const { db } = ctx;
  const machineName = (id: string): string => db.get<{ name: string }>('SELECT name FROM machines WHERE id = ?', id)?.name ?? '?';
  const seenMachines = new Set<string>();
  const machineMonitor = (id: string, why: string): void => {
    if (seenMachines.has(id)) return;
    seenMachines.add(id);
    out.push({ auto_key: `machine:${id}`, name: `Maschine ${machineName(id)} online`, kind: 'machine', environment: 'prod', group: 'Server', machine_id: id, severity_cap: 'warn', interval_seconds: 60, reason: why });
  };

  // Backups und Repliken
  const jobs = db.all<{ id: string; name: string; machine_id: string; schedule_json: string }>('SELECT id, name, machine_id, schedule_json FROM backup_jobs WHERE project_id = ?', projectId);
  for (const j of jobs) {
    const t = backupThresholds(parse<BackupSchedule | null>(j.schedule_json, null));
    if (t) {
      out.push({ auto_key: `backup:${j.id}`, name: `Backup „${j.name}“ aktuell`, kind: 'backup', environment: 'prod', group: 'Backup', config: { target: j.id, ...t }, severity_cap: 'warn', interval_seconds: 900, reason: 'Backup-Job mit Zeitplan' });
    }
    machineMonitor(j.machine_id, `Maschine des Backup-Jobs „${j.name}“`);
    const rep = db.get<{ machine_id: string }>('SELECT machine_id FROM backup_replicas WHERE job_id = ?', j.id);
    if (rep) {
      out.push({ auto_key: `replica:${j.id}`, name: `Replik „${j.name}“ auf ${machineName(rep.machine_id)}`, kind: 'replica', environment: 'prod', group: 'Backup', config: { target: j.id }, severity_cap: 'warn', interval_seconds: 300, reason: 'Backup-Replik eingerichtet' });
      machineMonitor(rep.machine_id, `Ziel-Maschine der Replik von „${j.name}“`);
    }
  }

  // Integrationen mit Zustandsprüfung
  for (const c of db.all<{ id: string; type: string; name: string }>('SELECT id, type, name FROM project_connectors WHERE project_id = ?', projectId)) {
    out.push({ auto_key: `connector:${c.id}`, name: `Integration ${c.name || c.type}`, kind: 'connector', environment: 'prod', group: 'Integrationen', config: { connector_id: c.id }, severity_cap: 'warn', interval_seconds: 900, reason: 'Integration des Projekts' });
  }

  // Supabase aus dem Vault (nur URL und anon-Schlüssel – kein Service-Key)
  const secrets = db.all<{ name: string; environment: string; vault_reference: string }>('SELECT name, environment, vault_reference FROM secrets WHERE project_id = ?', projectId);
  const environments = [...new Set(secrets.map((s) => s.environment))].sort((a, b) => (a === 'production' ? -1 : b === 'production' ? 1 : a.localeCompare(b)));
  const supabaseDone = new Set<'prod' | 'dev'>();
  for (const env of environments) {
    const kind = envOf(env);
    if (supabaseDone.has(kind)) continue;
    const urlSecret = secrets.find((s) => s.environment === env && /(^|_)SUPABASE_URL$/.test(s.name));
    if (!urlSecret || !ctx.vault) continue;
    let url: string | null = null;
    try {
      const v = ctx.vault.getString(urlSecret.vault_reference).trim();
      const u = new URL(v);
      if (u.protocol === 'https:') url = `${u.origin}`;
    } catch {
      url = null;
    }
    if (!url) continue;
    supabaseDone.add(kind);
    const anon = secrets.find((s) => s.environment === env && /(^|_)SUPABASE_ANON_KEY$/.test(s.name));
    const headers = anon ? [{ name: 'apikey', secret: { name: anon.name, environment: env } }] : [];
    const label = kind === 'prod' ? 'Produktion' : 'Entwicklung';
    out.push({ auto_key: `supabase-auth:${kind}`, name: `Supabase Anmeldung (${label})`, kind: 'http', environment: kind, group: 'Datenbank (Supabase)', config: { url: `${url}/auth/v1/health`, expect: anon ? 'ok' : 'reachable', headers }, interval_seconds: 300, reason: `Supabase-URL aus dem Secret ${urlSecret.name}` });
    out.push({ auto_key: `supabase-rest:${kind}`, name: `Supabase Datenbank-API (${label})`, kind: 'http', environment: kind, group: 'Datenbank (Supabase)', config: { url: `${url}/rest/v1/`, expect: 'reachable', headers: anon ? [{ name: 'apikey', secret: { name: anon.name, environment: env } }] : [] }, interval_seconds: 300, reason: `Supabase-URL aus dem Secret ${urlSecret.name}` });
  }

  // Domains und Mail-Server aus der Architektur-Karte
  try {
    const model = buildArchitecture(ctx, projectId);
    for (const c of model.components) {
      const details = c.details ?? [];
      const domain = details.find((d) => d.label.toLowerCase() === 'domain');
      if (domain && (c.kind === 'hosting' || c.kind === 'service')) {
        const host = String(domain.value).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host)) {
          out.push({ auto_key: `web:${host}`, name: `Website ${host}`, kind: 'http', environment: 'prod', group: `Hosting${c.provider ? ` (${c.provider})` : ''}`, config: { url: `https://${host}/`, expect: 'ok' }, interval_seconds: 300, reason: `Domain aus der Architektur-Karte (${c.name})` });
        }
      }
      if (c.kind === 'mail') {
        const text = `${c.provider ?? ''} ${c.description ?? ''} ${details.map((d) => d.value).join(' ')}`;
        if (/smtp\.ionos\.de/i.test(text)) out.push({ auto_key: 'smtp:ionos', name: 'Mail-Server IONOS (SMTP)', kind: 'tcp', environment: 'prod', group: 'Mail (IONOS)', config: { host: 'smtp.ionos.de', port: 465, tls: true }, severity_cap: 'warn', interval_seconds: 300, reason: `SMTP-Server aus der Architektur-Karte (${c.name})` });
        if (/brevo/i.test(text)) out.push({ auto_key: 'smtp:brevo', name: 'Mail-Server Brevo (SMTP)', kind: 'tcp', environment: 'prod', group: 'Mail (Brevo)', config: { host: 'smtp-relay.brevo.com', port: 587 }, severity_cap: 'warn', interval_seconds: 300, reason: `Brevo aus der Architektur-Karte (${c.name})` });
      }
    }
  } catch {
    /* Ohne Architektur-Karte gibt es eben nur die übrigen Vorschläge */
  }
  return out;
}

/** System-Monitore (ohne Projekt, nur Admin): System-Backups und deren Replik. */
export function suggestSystemMonitors(ctx: AppContext): Suggestion[] {
  const out: Suggestion[] = [];
  out.push({ auto_key: 'backup:system', name: 'System-Backup von DevDeck aktuell', kind: 'backup', environment: 'prod', group: 'Backup', config: { target: 'system', warn_hours: 36, error_hours: 72 }, severity_cap: 'warn', interval_seconds: 900, reason: 'DevDeck sichert sich täglich selbst' });
  if (ctx.db.get('SELECT 1 AS x FROM backup_replicas WHERE job_key = ?', 'system')) {
    out.push({ auto_key: 'replica:system', name: 'Replik der System-Backups', kind: 'replica', environment: 'prod', group: 'Backup', config: { target: 'system' }, severity_cap: 'warn', interval_seconds: 300, reason: 'System-Backups werden repliziert' });
  }
  return out;
}

/** Fehlende Vorschläge anlegen (anhand `auto_key`). */
export async function applySuggestions(
  ctx: AppContext,
  projectId: string | null,
  actor: { id: string | null; label: string; isAdmin: boolean },
): Promise<{ created: number; existing: number; failed: Array<{ name: string; error: string }> }> {
  const list = projectId ? suggestMonitors(ctx, projectId) : suggestSystemMonitors(ctx);
  let created = 0;
  let existing = 0;
  const failed: Array<{ name: string; error: string }> = [];
  for (const s of list) {
    const hit = ctx.db.get('SELECT 1 AS x FROM monitors WHERE COALESCE(project_id, \'\') = ? AND auto_key = ?', projectId ?? '', s.auto_key);
    if (hit) {
      existing += 1;
      continue;
    }
    try {
      const { auto_key, reason: _reason, ...input } = s;
      await createMonitor(ctx, { ...input, project_id: projectId }, actor, { key: auto_key });
      created += 1;
    } catch (err) {
      failed.push({ name: String(s.name), error: err instanceof Error ? err.message : 'unbekannt' });
    }
  }
  return { created, existing, failed };
}
