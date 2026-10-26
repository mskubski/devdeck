import { createHash } from 'node:crypto';
import type { MachineLogEntry, MachineLogLevel } from '@devdeck/shared';
import type { Database } from '../db/database.js';

/** Fehlerprotokolle werden so lange aufbewahrt (danach gelöscht), damit die Datenbank nicht überläuft. */
export const LOG_RETENTION_DAYS = 30;
/** Zusätzliche Obergrenze je Maschine; darüber werden die ältesten Einträge verworfen. */
export const LOG_MAX_PER_MACHINE = 5000;
/** Höchstzahl neuer Einträge je Meldung des Agenten. */
export const LOG_MAX_PER_REPORT = 300;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);

/** Meldung des Agenten prüfen: feste Felder, begrenzte Längen, plausible Zeitpunkte (nicht älter als die Aufbewahrung, nicht in der Zukunft). */
export function sanitizeLogReport(raw: unknown, now = Date.now()): { entries: MachineLogEntry[]; notes: string[]; collected_at: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const oldest = now - LOG_RETENTION_DAYS * 86_400_000;
  const entries: MachineLogEntry[] = [];
  for (const e of (Array.isArray(r.entries) ? r.entries : []).slice(0, LOG_MAX_PER_REPORT)) {
    const x = e as Record<string, unknown>;
    const message = str(x?.message, 600);
    const source = str(x?.source, 100);
    const t = typeof x?.time === 'string' ? Date.parse(x.time) : NaN;
    if (!message || !source || !Number.isFinite(t) || t < oldest || t > now + 86_400_000) continue;
    entries.push({
      time: new Date(t).toISOString(), source, provider: str(x.provider, 150), event_id: str(x.event_id, 40),
      level: (x.level === 'critical' ? 'critical' : 'error') as MachineLogLevel, message,
    });
  }
  return {
    entries,
    notes: (Array.isArray(r.notes) ? r.notes : []).map((n) => str(n, 300)).filter((n): n is string => n !== null).slice(0, 5),
    collected_at: str(r.collected_at, 40) ?? new Date(now).toISOString(),
  };
}

const hashOf = (e: MachineLogEntry): string =>
  createHash('sha1').update([e.time, e.source, e.provider ?? '', e.event_id ?? '', e.message.slice(0, 300)].join('\u0000')).digest('hex');

/** Neue Einträge speichern (gleiche Einträge aus überlappenden Zeiträumen werden ignoriert). */
export function storeMachineLogs(db: Database, machineId: string, entries: MachineLogEntry[]): number {
  let added = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const e of entries) {
      const res = db.run(
        `INSERT OR IGNORE INTO machine_logs (machine_id, occurred_at, source, provider, event_id, level, message, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        machineId, e.time, e.source, e.provider, e.event_id, e.level, e.message, hashOf(e), now,
      );
      added += res.changes;
    }
  });
  return added;
}

/** Aufbewahrung: Einträge älter als {@link LOG_RETENTION_DAYS} löschen und je Maschine auf {@link LOG_MAX_PER_MACHINE} begrenzen. */
export function pruneMachineLogs(db: Database, opts: { machineId?: string; now?: number; maxPerMachine?: number } = {}): number {
  const cutoff = new Date((opts.now ?? Date.now()) - LOG_RETENTION_DAYS * 86_400_000).toISOString();
  const max = opts.maxPerMachine ?? LOG_MAX_PER_MACHINE;
  let removed = 0;
  db.transaction(() => {
    removed += opts.machineId
      ? db.run('DELETE FROM machine_logs WHERE machine_id = ? AND occurred_at < ?', opts.machineId, cutoff).changes
      : db.run('DELETE FROM machine_logs WHERE occurred_at < ?', cutoff).changes;
    const ids = opts.machineId
      ? [{ machine_id: opts.machineId }]
      : db.all<{ machine_id: string }>('SELECT machine_id FROM machine_logs GROUP BY machine_id HAVING COUNT(*) > ?', max);
    for (const { machine_id } of ids) {
      removed += db.run(
        `DELETE FROM machine_logs WHERE machine_id = ? AND id NOT IN
           (SELECT id FROM machine_logs WHERE machine_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?)`,
        machine_id, machine_id, max,
      ).changes;
    }
  });
  return removed;
}
