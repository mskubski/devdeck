import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@devdeck/shared';
import { dirBytes, listFiles, safeJoin } from './fsutil.js';
import { lastKnownTables } from './bundle.js';

/** Supabase-Projekt sichern: alle Tabellen (PostgREST), das Schema (aus der OpenAPI-Beschreibung) und alle Storage-Buckets. Format wie das bisherige PeeFinder-Skript. */
export interface SupabaseAccess {
  url: string;
  key: string;
}

const PAGE = 1000;

interface Column {
  type: string;
  format?: string;
  pk: boolean;
  required: boolean;
}

interface TableDef {
  name: string;
  columns: Record<string, Column>;
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

/** fetch mit Zeitlimit und wiederholten Versuchen bei Netzwerkfehlern/5xx. */
async function request(url: string, init: RequestInit, timeoutMs = 60_000, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && i < attempts - 1) {
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new AppError('INTERNAL', `Supabase nicht erreichbar: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function baseUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)) {
    throw new AppError('VALIDATION', 'Die Supabase-URL muss die Form https://<projekt>.supabase.co haben');
  }
  return u;
}

/** Tabellen und Spalten aus der OpenAPI-Beschreibung von PostgREST (benötigt den Service-Key). */
async function listTables(access: SupabaseAccess, targetDir: string): Promise<{ tables: TableDef[]; source: 'api' | 'previous-backup' }> {
  const res = await request(`${access.url}/rest/v1/`, { headers: headers(access.key, { Accept: 'application/openapi+json' }) }, 30_000);
  if (res.status === 401 || res.status === 403) {
    throw new AppError('SECRET_UNAVAILABLE', 'Supabase hat den Schlüssel abgelehnt (Service-Role-Key prüfen)');
  }
  if (res.ok) {
    const spec = (await res.json()) as { definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string; description?: string }>; required?: string[] }> };
    const tables = Object.entries(spec.definitions ?? {}).map(([name, def]) => ({
      name,
      columns: Object.fromEntries(
        Object.entries(def.properties ?? {}).map(([col, p]) => [
          col,
          { type: p.type ?? 'string', format: p.format, pk: (p.description ?? '').includes('<pk/>'), required: (def.required ?? []).includes(col) },
        ]),
      ),
    }));
    if (tables.length > 0) return { tables, source: 'api' };
  }
  // Rückfall: Tabellenliste aus dem letzten Backup (ohne Spaltentypen)
  const known = lastKnownTables(targetDir);
  if (known.length > 0) return { tables: known.map((name) => ({ name, columns: {} })), source: 'previous-backup' };
  throw new AppError('INTERNAL', `Tabellenliste nicht abrufbar (HTTP ${res.status}) und kein früheres Backup als Vorlage vorhanden`);
}

const safeName = (table: string): string => table.replace(/\./g, '_');

/**
 * Tabelle seitenweise exportieren. Bei einem einzelnen Schlüssel (Primärschlüssel oder `id`) per Keyset-Paginierung
 * (`id=gt.<letzter>`): jede Seite ist ein Indexzugriff, unabhängig von der Tabellengröße. Tiefes OFFSET dagegen wird bei
 * großen Tabellen langsam und läuft in den Statement-Timeout von Supabase. Ohne eindeutigen Schlüssel bleibt nur OFFSET.
 * Läuft eine Seite trotzdem in einen Timeout, wird die Seitengröße halbiert.
 */
async function exportTable(access: SupabaseAccess, def: TableDef, file: string, progress: (text: string) => void): Promise<number> {
  const pk = Object.entries(def.columns).filter(([, c]) => c.pk).map(([n]) => n);
  const keyColumn = pk.length === 1 ? pk[0]! : pk.length === 0 && def.columns.id ? 'id' : null;
  const order = keyColumn
    ? `&order=${encodeURIComponent(keyColumn)}.asc`
    : pk.length > 0 ? `&order=${pk.map((c) => `${encodeURIComponent(c)}.asc`).join(',')}` : '';
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  let rows = 0;
  let size = PAGE;
  let last: unknown = null;
  try {
    out.write('[');
    for (;;) {
      const filter = keyColumn && last !== null ? `&${encodeURIComponent(keyColumn)}=gt.${encodeURIComponent(String(last))}` : '';
      const url = `${access.url}/rest/v1/${encodeURIComponent(def.name)}?select=*${order}${filter}`;
      const res = keyColumn
        ? await request(`${url}&limit=${size}`, { headers: headers(access.key) }, 120_000, 1)
        : await request(url, { headers: headers(access.key, { Range: `${rows}-${rows + size - 1}`, 'Range-Unit': 'items' }) }, 120_000, 1);
      if (res.status === 416) break; // Anzahl war ein Vielfaches der Seitengröße: nichts mehr hinter dem Ende
      if (!res.ok && res.status !== 206) {
        const body = (await res.text()).slice(0, 200);
        if (res.status >= 500 && size > 50) {
          size = Math.max(50, Math.floor(size / 2)); // Timeout o. ä.: kleinere Seite versuchen
          progress(`Tabelle ${def.name}: Seitengröße auf ${size} reduziert`);
          continue;
        }
        throw new AppError('INTERNAL', `Tabelle ${def.name}: HTTP ${res.status} ${body}`);
      }
      const page = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(page) || page.length === 0) break;
      for (const row of page) {
        out.write(`${rows === 0 ? '\n' : ',\n'}${JSON.stringify(row)}`);
        rows += 1;
      }
      if (keyColumn) last = page[page.length - 1]![keyColumn] ?? null;
      progress(`Tabelle ${def.name}: ${rows} Zeilen`);
      if (page.length < size || (keyColumn && last === null)) break;
    }
    out.write('\n]\n');
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return rows;
}

/** Ableitung eines CREATE TABLE aus der OpenAPI-Beschreibung (Spaltennamen, -typen, Primärschlüssel, NOT NULL). */
function schemaSql(tables: TableDef[], source: string): string {
  const lines = [`-- DevDeck Schema-Export (aus der PostgREST-OpenAPI-Beschreibung)`, `-- Erzeugt: ${new Date().toISOString()}`, `-- Quelle: ${source}`, ''];
  for (const t of tables) {
    const cols = Object.entries(t.columns);
    if (cols.length === 0) {
      lines.push(`-- Tabelle ${t.name}: Spalten unbekannt`, '');
      continue;
    }
    const pk = cols.filter(([, c]) => c.pk).map(([n]) => `"${n}"`);
    const defs = cols.map(([n, c]) => `  "${n}" ${c.format ?? c.type}${c.required || c.pk ? ' NOT NULL' : ''}`);
    if (pk.length > 0) defs.push(`  PRIMARY KEY (${pk.join(', ')})`);
    lines.push(`CREATE TABLE IF NOT EXISTS "${t.name}" (`, defs.join(',\n'), ');', '');
  }
  lines.push('-- Hinweis: Funktionen, Trigger, Policies und Indizes sind über die REST-API nicht auslesbar.', '');
  return lines.join('\n');
}

async function listBuckets(access: SupabaseAccess): Promise<string[]> {
  const res = await request(`${access.url}/storage/v1/bucket`, { headers: headers(access.key) }, 30_000);
  if (!res.ok) throw new AppError('INTERNAL', `Buckets nicht abrufbar: HTTP ${res.status}`);
  return ((await res.json()) as Array<{ name?: string; id?: string }>).map((b) => b.name ?? b.id ?? '').filter(Boolean);
}

/** Alle Objektpfade eines Buckets (Supabase listet je Ebene; Ordner haben keine id). */
async function listObjects(access: SupabaseAccess, bucket: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (prefix: string): Promise<void> => {
    let offset = 0;
    for (;;) {
      const res = await request(
        `${access.url}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        { method: 'POST', headers: headers(access.key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix, limit: 100, offset }) },
        30_000,
      );
      if (!res.ok) throw new AppError('INTERNAL', `Bucket ${bucket}: Auflistung fehlgeschlagen (HTTP ${res.status})`);
      const items = (await res.json()) as Array<{ name?: string; id?: string | null }>;
      if (items.length === 0) break;
      for (const item of items) {
        if (!item.name) continue;
        if (item.id == null) await walk(`${prefix}${item.name}/`);
        else paths.push(`${prefix}${item.name}`);
      }
      offset += items.length;
      if (items.length < 100) break;
    }
  };
  await walk('');
  return paths;
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

async function downloadObject(access: SupabaseAccess, bucket: string, objectPath: string, dest: string): Promise<void> {
  const res = await request(`${access.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`, { headers: headers(access.key) }, 120_000);
  if (!res.ok || !res.body) throw new AppError('INTERNAL', `Download ${bucket}/${objectPath}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest));
}

export interface SupabaseBackupResult {
  tables: string[];
  rows: number;
  storage_files: number;
  storage_buckets: string[];
  schema_files: number;
  table_source: 'api' | 'previous-backup';
}

export async function backupSupabase(options: {
  access: SupabaseAccess;
  bundleDir: string;
  targetDir: string;
  buckets: string[];
  schema: boolean;
  progress: (text: string) => void;
}): Promise<SupabaseBackupResult> {
  const access = { url: baseUrl(options.access.url), key: options.access.key };
  const { tables, source } = await listTables(access, options.targetDir);

  const dbDir = path.join(options.bundleDir, 'database');
  fs.mkdirSync(dbDir, { recursive: true });
  let rows = 0;
  for (const def of tables) {
    options.progress(`Tabelle ${def.name} …`);
    rows += await exportTable(access, def, path.join(dbDir, `${safeName(def.name)}.json`), options.progress);
  }

  let schemaFiles = 0;
  if (options.schema) {
    const dir = path.join(options.bundleDir, 'schema');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tables_schema.sql'), schemaSql(tables, access.url));
    schemaFiles = 1;
  }

  const allBuckets = await listBuckets(access);
  const wanted = options.buckets.length > 0 ? options.buckets : allBuckets;
  const missing = wanted.filter((b) => !allBuckets.includes(b));
  if (missing.length > 0) throw new AppError('NOT_FOUND', `Storage-Bucket nicht gefunden: ${missing.join(', ')}`);
  let files = 0;
  for (const bucket of wanted) {
    options.progress(`Bucket ${bucket}: Dateien auflisten …`);
    const objects = await listObjects(access, bucket);
    const bucketDir = path.join(options.bundleDir, 'storage', bucket);
    fs.mkdirSync(bucketDir, { recursive: true });
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= objects.length) return;
        await downloadObject(access, bucket, objects[i]!, safeJoin(bucketDir, objects[i]!));
        files += 1;
        if (files % 25 === 0) options.progress(`Bucket ${bucket}: ${files} Dateien`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  return { tables: tables.map((t) => t.name), rows, storage_files: files, storage_buckets: wanted, schema_files: schemaFiles, table_source: source };
}

/** Felder, die das bisherige PeeFinder-Skript im Manifest führt (damit dessen `list`/`verify` weiter funktionieren). */
export function legacyManifestFields(result: SupabaseBackupResult, access: SupabaseAccess, bundleDir: string, durationSeconds: number): Record<string, unknown> {
  const mb = (dir: string): number => Math.round((dirBytes(dir) / 1024 / 1024) * 100) / 100;
  const ref = /^https:\/\/([^.]+)\./.exec(access.url)?.[1] ?? null;
  return {
    db_rows: result.rows,
    db_size_mb: mb(path.join(bundleDir, 'database')),
    storage_files: result.storage_files,
    storage_size_mb: mb(path.join(bundleDir, 'storage')),
    schema_files: result.schema_files,
    schema_size_mb: mb(path.join(bundleDir, 'schema')),
    duration_seconds: Math.round(durationSeconds * 10) / 10,
    tables_exported: result.tables,
    supabase_url: access.url,
    supabase_project_ref: ref,
    storage_buckets: result.storage_buckets,
    backup_type: result.schema_files > 0 ? 'full' : 'data_only',
  };
}

// ── Wiederherstellung (wird ausschließlich über die bestätigte Restore-Aktion aufgerufen) ──

/** Tabellen per Upsert (merge-duplicates) zurückschreiben; löscht nie. Tabellen mit Fremdschlüsseln werden in mehreren Durchgängen wiederholt. */
export async function restoreSupabase(options: {
  access: SupabaseAccess;
  bundleDir: string;
  progress: (text: string) => void;
}): Promise<{ tables: number; rows: number; files: number; failed: string[] }> {
  const access = { url: baseUrl(options.access.url), key: options.access.key };
  const dbDir = path.join(options.bundleDir, 'database');
  let pending = fs.existsSync(dbDir) ? fs.readdirSync(dbDir).filter((f) => f.endsWith('.json')).sort() : [];
  const total = pending.length;
  let rows = 0;
  let lastErrors: Record<string, string> = {};
  for (let pass = 1; pass <= 3 && pending.length > 0; pass += 1) {
    const failed: string[] = [];
    lastErrors = {};
    for (const file of pending) {
      const table = file.slice(0, -'.json'.length); // Ordnername nutzt "_" für "." – Tabellen im public-Schema haben keinen Punkt
      options.progress(`Restore Tabelle ${table} (Durchgang ${pass}) …`);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dbDir, file), 'utf8')) as unknown[];
        for (let i = 0; i < data.length; i += 500) {
          const res = await request(
            `${access.url}/rest/v1/${encodeURIComponent(table)}`,
            {
              method: 'POST',
              headers: headers(access.key, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
              body: JSON.stringify(data.slice(i, i + 500)),
            },
            120_000,
          );
          if (!res.ok) throw new AppError('INTERNAL', `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        }
        rows += data.length;
      } catch (err) {
        failed.push(file);
        lastErrors[table] = err instanceof Error ? err.message : String(err);
      }
    }
    pending = failed;
  }

  let files = 0;
  const storageDir = path.join(options.bundleDir, 'storage');
  if (fs.existsSync(storageDir)) {
    for (const bucket of fs.readdirSync(storageDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const rel of listFiles(path.join(storageDir, bucket.name))) {
        const res = await request(
          `${access.url}/storage/v1/object/${encodeURIComponent(bucket.name)}/${encodePath(rel)}`,
          {
            method: 'POST',
            headers: headers(access.key, { 'x-upsert': 'true', 'Content-Type': 'application/octet-stream' }),
            body: fs.readFileSync(path.join(storageDir, bucket.name, rel)),
          },
          120_000,
        );
        if (!res.ok) throw new AppError('INTERNAL', `Upload ${bucket.name}/${rel}: HTTP ${res.status}`);
        files += 1;
        if (files % 25 === 0) options.progress(`Restore Storage: ${files} Dateien`);
      }
    }
  }
  const failedNames = pending.map((f) => `${f.slice(0, -5)} (${lastErrors[f.slice(0, -5)] ?? 'Fehler'})`);
  return { tables: total - pending.length, rows, files, failed: failedNames };
}
