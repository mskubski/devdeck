/** DevDeck – Projekt-Backups: Quellen, Zeitplan, Aufbewahrung (gemeinsam für Server und Agent). */
import { AppError } from './errors.js';

export const BACKUP_SOURCE_KINDS = ['supabase', 'postgres', 'sqlite', 'files'] as const;
export type BackupSourceKind = (typeof BACKUP_SOURCE_KINDS)[number];

/** Eine zu sichernde Quelle eines Projekts. `config` ist je nach `kind` fest umrissen (siehe normalizeBackupSources). */
export interface BackupSource {
  id: string;
  kind: BackupSourceKind;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export const BACKUP_SCHEDULE_MODES = ['off', 'daily', 'weekly', 'interval'] as const;
export interface BackupSchedule {
  mode: (typeof BACKUP_SCHEDULE_MODES)[number];
  /** HH:MM, Serverzeit (daily/weekly) */
  time: string;
  /** 0 = Sonntag … 6 = Samstag (weekly) */
  weekday: number;
  /** Abstand in Stunden (interval) */
  every_hours: number;
}

export interface BackupRetention {
  /** Backups, die älter sind, werden gelöscht … */
  keep_days: number;
  /** … aber es bleiben immer mindestens so viele (die neuesten) erhalten. */
  keep_min: number;
}

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { mode: 'daily', time: '03:00', weekday: 1, every_hours: 24 };
export const DEFAULT_BACKUP_RETENTION: BackupRetention = { keep_days: 30, keep_min: 5 };

/** Wörtlich einzutippende Bestätigung für jeden Restore (UI und Server prüfen sie, der Agent erneut). */
export const RESTORE_CONFIRM_PHRASE = 'Restore starten';

/** Ordnername eines Backups: lokale Zeit wie beim bisherigen PeeFinder-Skript (YYYY-MM-DD_HHMMSS). */
export const BUNDLE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{6}$/;
export const BACKUP_MANIFEST_FILE = 'backup_manifest.json';
export const BACKUP_FORMAT_VERSION = 2;

const pad = (n: number): string => String(n).padStart(2, '0');

export function bundleNameFor(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Zeitpunkt (lokale Zeit) aus einem Bundle-Namen; null, wenn der Name nicht dem Muster entspricht. */
export function parseBundleName(name: string): Date | null {
  if (!BUNDLE_NAME_PATTERN.test(name)) return null;
  const d = new Date(
    Number(name.slice(0, 4)), Number(name.slice(5, 7)) - 1, Number(name.slice(8, 10)),
    Number(name.slice(11, 13)), Number(name.slice(13, 15)), Number(name.slice(15, 17)),
  );
  // JS-Date rollt ungültige Werte (Monat 13, Tag 45) stillschweigend über – dann ist es kein Backup-Name
  return d.getFullYear() === Number(name.slice(0, 4)) && bundleNameFor(d) === name ? d : null;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_SOURCES = 20;

function str(v: unknown, field: string, max: number, required = true): string {
  if (typeof v !== 'string' || (required && v.trim() === '')) {
    throw new AppError('VALIDATION', `Quelle: „${field}“ fehlt oder ist kein Text`);
  }
  if (v.length > max) throw new AppError('VALIDATION', `Quelle: „${field}“ ist zu lang (max. ${max})`);
  return v;
}

function secretName(v: unknown, field: string): string {
  const s = str(v, field, 100);
  if (!SECRET_NAME.test(s)) throw new AppError('VALIDATION', `Quelle: „${field}“ ist kein gültiger Secret-Name`);
  return s;
}

function strList(v: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems) throw new AppError('VALIDATION', `Quelle: „${field}“ muss eine Liste sein`);
  return v.map((x) => str(x, field, maxLen));
}

/** Prüft/normalisiert die Quellenliste eines Backup-Jobs. Unbekannte Konfigurationsfelder werden verworfen. */
export function normalizeBackupSources(input: unknown): BackupSource[] {
  if (!Array.isArray(input)) throw new AppError('VALIDATION', 'sources muss eine Liste sein');
  if (input.length === 0) throw new AppError('VALIDATION', 'Mindestens eine Quelle ist erforderlich');
  if (input.length > MAX_SOURCES) throw new AppError('VALIDATION', `Höchstens ${MAX_SOURCES} Quellen je Job`);
  const seen = new Set<string>();
  const out: BackupSource[] = [];
  for (const raw of input) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const kind = r.kind;
    if (!(BACKUP_SOURCE_KINDS as readonly unknown[]).includes(kind)) {
      throw new AppError('VALIDATION', `Unbekannte Quellenart: ${String(kind)}`);
    }
    const id = str(r.id, 'id', 40);
    if (!SOURCE_ID.test(id)) throw new AppError('VALIDATION', `Ungültige Quellen-ID: ${id}`);
    if (seen.has(id)) throw new AppError('VALIDATION', `Quellen-ID doppelt: ${id}`);
    seen.add(id);
    const c = (r.config ?? {}) as Record<string, unknown>;
    let config: Record<string, unknown>;
    switch (kind as BackupSourceKind) {
      case 'supabase':
        config = {
          url_secret: secretName(c.url_secret, 'url_secret'),
          key_secret: secretName(c.key_secret, 'key_secret'),
          environment: str(c.environment ?? 'production', 'environment', 20),
          buckets: strList(c.buckets, 'buckets', 50, 100), // leer = alle Buckets
          schema: c.schema !== false,
        };
        break;
      case 'postgres':
        config = {
          url_secret: secretName(c.url_secret, 'url_secret'),
          environment: str(c.environment ?? 'production', 'environment', 20),
        };
        break;
      case 'sqlite':
        config = { path: str(c.path, 'path', 500) };
        break;
      case 'files':
        config = { path: str(c.path, 'path', 500), exclude: strList(c.exclude, 'exclude', 50, 200) };
        break;
    }
    out.push({
      id,
      kind: kind as BackupSourceKind,
      label: str(r.label ?? id, 'label', 120),
      enabled: r.enabled !== false,
      config,
    });
  }
  if (out.filter((s) => s.kind === 'supabase').length > 1) {
    throw new AppError('VALIDATION', 'Je Job ist nur eine Supabase-Quelle möglich');
  }
  if (!out.some((s) => s.enabled)) throw new AppError('VALIDATION', 'Mindestens eine Quelle muss aktiv sein');
  return out;
}

function intIn(v: unknown, min: number, max: number, field: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError('VALIDATION', `„${field}“ muss eine ganze Zahl zwischen ${min} und ${max} sein`);
  }
  return n;
}

export function normalizeBackupSchedule(input: unknown): BackupSchedule {
  const r = (input ?? {}) as Record<string, unknown>;
  const mode = r.mode;
  if (!(BACKUP_SCHEDULE_MODES as readonly unknown[]).includes(mode)) {
    throw new AppError('VALIDATION', 'Zeitplan: Modus muss off, daily, weekly oder interval sein');
  }
  const time = typeof r.time === 'string' ? r.time : DEFAULT_BACKUP_SCHEDULE.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError('VALIDATION', 'Zeitplan: Uhrzeit muss HH:MM sein');
  return {
    mode: mode as BackupSchedule['mode'],
    time,
    weekday: intIn(r.weekday ?? DEFAULT_BACKUP_SCHEDULE.weekday, 0, 6, 'weekday'),
    every_hours: intIn(r.every_hours ?? DEFAULT_BACKUP_SCHEDULE.every_hours, 1, 720, 'every_hours'),
  };
}

export function normalizeBackupRetention(input: unknown): BackupRetention {
  const r = (input ?? {}) as Record<string, unknown>;
  return {
    keep_days: intIn(r.keep_days ?? DEFAULT_BACKUP_RETENTION.keep_days, 1, 3650, 'keep_days'),
    keep_min: intIn(r.keep_min ?? DEFAULT_BACKUP_RETENTION.keep_min, 1, 1000, 'keep_min'),
  };
}

/** Jüngster planmäßiger Zeitpunkt (≤ now) für daily/weekly in lokaler Zeit; null bei interval/off. */
export function lastScheduledOccurrence(schedule: BackupSchedule, now: Date): Date | null {
  if (schedule.mode !== 'daily' && schedule.mode !== 'weekly') return null;
  const [h, m] = schedule.time.split(':').map(Number) as [number, number];
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  if (schedule.mode === 'weekly') {
    while (d.getDay() !== schedule.weekday) d.setDate(d.getDate() - 1);
  }
  return d;
}

/**
 * Ist ein geplanter Lauf fällig? `lastTriggeredAt` ist der letzte Auslösezeitpunkt (geplant oder manuell).
 * Verpasste Läufe (Maschine war offline) werden einmal nachgeholt, nicht mehrfach.
 */
export function isBackupDue(schedule: BackupSchedule, lastTriggeredAt: string | null, now: Date): boolean {
  if (schedule.mode === 'off') return false;
  const last = lastTriggeredAt ? Date.parse(lastTriggeredAt) : null;
  if (schedule.mode === 'interval') {
    return last === null || Number.isNaN(last) || now.getTime() - last >= schedule.every_hours * 3_600_000;
  }
  const occurrence = lastScheduledOccurrence(schedule, now)!;
  return last === null || Number.isNaN(last) || last < occurrence.getTime();
}

/** Nächster planmäßiger Zeitpunkt (nur Anzeige); null bei off. Für interval relativ zum letzten Lauf. */
export function nextScheduledRun(schedule: BackupSchedule, lastTriggeredAt: string | null, now: Date): Date | null {
  if (schedule.mode === 'off') return null;
  if (schedule.mode === 'interval') {
    const last = lastTriggeredAt ? Date.parse(lastTriggeredAt) : Number.NaN;
    return Number.isNaN(last) ? now : new Date(last + schedule.every_hours * 3_600_000);
  }
  const prev = lastScheduledOccurrence(schedule, now)!;
  const next = new Date(prev);
  next.setDate(next.getDate() + (schedule.mode === 'weekly' ? 7 : 1));
  return next;
}

/**
 * Aufbewahrung: Löschkandidaten sind Backups, die älter als `keep_days` sind – außer den `keep_min` neuesten.
 * Nur erfolgreiche, bekannte Backups gehen hier ein (der Aufrufer filtert Unvollständiges vorher heraus).
 */
export function selectBundlesToDelete(
  bundles: Array<{ name: string; created_at: string }>,
  retention: BackupRetention,
  now: Date,
): string[] {
  const sorted = [...bundles].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); // neueste zuerst
  const cutoff = now.getTime() - retention.keep_days * 86_400_000;
  return sorted
    .slice(retention.keep_min)
    .filter((b) => Date.parse(b.created_at) < cutoff)
    .map((b) => b.name);
}

/** Angaben zu einem vorhandenen Backup-Ordner, vom Agenten gemeldet. */
export interface BackupBundleInfo {
  name: string;
  created_at: string;
  size_bytes: number;
  format: 'devdeck' | 'legacy';
  summary: Record<string, unknown>;
  verify?: { ok: boolean; problems: string[] };
}

/** Meldung des Agenten an den Server (Fortschritt, Ergebnis, Ordner-Scan, Restore). */
export interface BackupReport {
  job_id: string;
  kind: 'run' | 'scan' | 'restore';
  run_id?: string;
  restore_id?: string;
  status?: 'running' | 'success' | 'failed';
  progress?: string;
  bundle_name?: string;
  created_at?: string;
  size_bytes?: number;
  summary?: Record<string, unknown>;
  error?: string;
  /** scan: alle gefundenen Backups; run: nur das neue */
  bundles?: BackupBundleInfo[];
  /** durch die Aufbewahrung gelöschte Backups */
  deleted?: string[];
}

// ── Replikation (Kopie von Backups auf eine zweite Maschine) ──

/** System-Backups des Servers heißen `devdeck-<Zeitstempel>` (Doppelpunkte und Punkte durch `-` ersetzt). */
export const SYSTEM_BUNDLE_NAME_PATTERN = /^devdeck-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** Nur Ordner mit diesen Namen werden repliziert oder auf der Replik gelöscht – alles andere im Zielordner bleibt unangetastet. */
export function isReplicableBundleName(name: string): boolean {
  return BUNDLE_NAME_PATTERN.test(name) || SYSTEM_BUNDLE_NAME_PATTERN.test(name);
}

/** Relativer Dateipfad innerhalb eines Backups, wie er zwischen Agent und Server übertragen wird (immer `/`, nie nach oben, nie absolut). */
export function isSafeTransferPath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.length > 500) return false;
  if (rel.includes('\\') || rel.includes('\0') || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export interface TransferFile {
  path: string;
  sha256: string;
  bytes: number;
}
