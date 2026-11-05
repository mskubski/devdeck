import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_FILE,
  BUNDLE_NAME_PATTERN,
  parseBundleName,
  type BackupBundleInfo,
} from '@devdeck/shared';
import { dirBytes, listFiles, safeJoin, sha256File } from './fsutil.js';

export interface ManifestItem {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SourceResult {
  id: string;
  kind: string;
  label: string;
  bytes: number;
  detail: Record<string, unknown>;
}

/** Manifest eines Backups. Die Felder oberhalb von `devdeck` entsprechen dem bisherigen PeeFinder-Skript (rückwärtskompatibel). */
export interface BundleManifest {
  timestamp: string;
  [legacy: string]: unknown;
  devdeck?: {
    format: number;
    job_id: string;
    trigger: string;
    duration_seconds: number;
    sources: SourceResult[];
    items: ManifestItem[];
  };
}

export function readManifest(dir: string): BundleManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, BACKUP_MANIFEST_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as BundleManifest) : null;
  } catch {
    return null;
  }
}

/** Prüfsummen aller Dateien eines fertigen Bundles (ohne das Manifest selbst). */
export async function buildItems(dir: string): Promise<ManifestItem[]> {
  const items: ManifestItem[] = [];
  for (const rel of listFiles(dir).sort()) {
    if (rel === BACKUP_MANIFEST_FILE) continue;
    const full = path.join(dir, rel);
    items.push({ path: rel, sha256: await sha256File(full), bytes: fs.statSync(full).size });
  }
  return items;
}

export function writeManifest(dir: string, manifest: BundleManifest): void {
  fs.writeFileSync(path.join(dir, BACKUP_MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

export function newManifestBase(
  jobId: string,
  trigger: string,
  durationSeconds: number,
  sources: SourceResult[],
  items: ManifestItem[],
): BundleManifest {
  return {
    timestamp: new Date().toISOString(),
    devdeck: { format: BACKUP_FORMAT_VERSION, job_id: jobId, trigger, duration_seconds: durationSeconds, sources, items },
  };
}

function summarize(manifest: BundleManifest): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (typeof manifest.db_rows === 'number') summary.rows = manifest.db_rows;
  if (Array.isArray(manifest.tables_exported)) summary.tables = manifest.tables_exported.length;
  if (typeof manifest.storage_files === 'number') summary.storage_files = manifest.storage_files;
  if (typeof manifest.duration_seconds === 'number') summary.duration_seconds = manifest.duration_seconds;
  if (manifest.devdeck) {
    summary.duration_seconds = manifest.devdeck.duration_seconds;
    summary.sources = manifest.devdeck.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, bytes: s.bytes }));
  }
  return summary;
}

/** Alle erkennbaren Backups eines Zielordners (Ordnername = Zeitstempel + Manifest), neueste zuerst. */
export function scanBundles(targetDir: string): BackupBundleInfo[] {
  if (!fs.existsSync(targetDir)) return [];
  const out: BackupBundleInfo[] = [];
  for (const e of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !BUNDLE_NAME_PATTERN.test(e.name)) continue;
    const dir = path.join(targetDir, e.name);
    const manifest = readManifest(dir);
    if (!manifest) continue; // unvollständig oder fremd – nie anfassen
    const created = parseBundleName(e.name) ?? new Date(String(manifest.timestamp));
    if (Number.isNaN(created.getTime())) continue;
    out.push({
      name: e.name,
      created_at: created.toISOString(),
      size_bytes: dirBytes(dir),
      format: manifest.devdeck ? 'devdeck' : 'legacy',
      summary: summarize(manifest),
    });
  }
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** Tabellennamen aus dem Manifest des neuesten Backups (Rückfall, wenn die API keine Tabellenliste liefert). */
export function lastKnownTables(targetDir: string): string[] {
  for (const b of scanBundles(targetDir)) {
    const m = readManifest(path.join(targetDir, b.name));
    if (m && Array.isArray(m.tables_exported)) return m.tables_exported.filter((t): t is string => typeof t === 'string');
  }
  return [];
}

function endsWithJsonArray(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 2) return false;
    const len = Math.min(size, 64);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').trimEnd().endsWith(']');
  } finally {
    fs.closeSync(fd);
  }
}

/** Prüft ein Backup: DevDeck-Format per Prüfsumme, älteres PeeFinder-Format strukturell (Dateien vorhanden, JSON vollständig). */
export async function verifyBundleDir(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, problems: ['Manifest fehlt oder ist nicht lesbar'] };
  if (manifest.devdeck) {
    for (const item of manifest.devdeck.items ?? []) {
      let full: string;
      try {
        full = safeJoin(dir, item.path);
      } catch {
        problems.push(`Unzulässiger Pfad im Manifest: ${item.path}`);
        continue;
      }
      if (!fs.existsSync(full)) problems.push(`Fehlt: ${item.path}`);
      else if ((await sha256File(full)) !== item.sha256) problems.push(`Prüfsumme stimmt nicht: ${item.path}`);
    }
    return { ok: problems.length === 0, problems };
  }
  const tables = Array.isArray(manifest.tables_exported) ? (manifest.tables_exported as string[]) : [];
  for (const t of tables) {
    const file = path.join(dir, 'database', `${t.replace(/\./g, '_')}.json`);
    if (!fs.existsSync(file)) problems.push(`Tabelle fehlt: ${t}`);
    else if (!endsWithJsonArray(file)) problems.push(`Tabelle unvollständig: ${t}`);
  }
  if (typeof manifest.storage_files === 'number') {
    const found = listFiles(path.join(dir, 'storage')).length;
    if (found !== manifest.storage_files) problems.push(`Storage: ${found} Dateien statt ${manifest.storage_files}`);
  }
  return { ok: problems.length === 0, problems };
}
