import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { ALWAYS_EXCLUDED, run } from './fsutil.js';

/** SQLite-Datei konsistent sichern (VACUUM INTO, auch bei laufender Anwendung); ohne node:sqlite als Dateikopie. */
export async function backupSqlite(source: string, dest: string): Promise<number> {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new AppError('NOT_FOUND', `SQLite-Datei nicht gefunden: ${source}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let sqlite: typeof import('node:sqlite') | null = null;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    sqlite = null;
  }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(source, { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } else {
    fs.copyFileSync(source, dest);
  }
  return fs.statSync(dest).size;
}

/** Ordner als .tar.gz sichern (System-`tar`, auch unter Windows 10+ vorhanden). Abhängigkeiten, .git und Zugangsdaten bleiben außen vor. */
export async function backupDirectory(source: string, dest: string, extraExclude: string[]): Promise<number> {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new AppError('NOT_FOUND', `Ordner nicht gefunden: ${source}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const excludes = [...ALWAYS_EXCLUDED, ...extraExclude].flatMap((p) => ['--exclude', p]);
  await run('tar', ['-czf', dest, ...excludes, '-C', path.dirname(source), path.basename(source)]);
  return fs.statSync(dest).size;
}

/** Verbindungsdaten für pg_dump/pg_restore: nur über Umgebungsvariablen (nie als Argument, sonst in der Prozessliste sichtbar). */
export function pgEnv(connection: string): { env: Record<string, string>; database: string } {
  let u: URL;
  try {
    u = new URL(connection);
  } catch {
    throw new AppError('VALIDATION', 'Die Datenbank-URL ist ungültig (erwartet: postgresql://benutzer:passwort@host:port/datenbank)');
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new AppError('VALIDATION', 'Die Datenbank-URL muss mit postgresql:// beginnen');
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
  };
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return { env, database };
}

export async function backupPostgres(connection: string, dest: string): Promise<number> {
  const { env } = pgEnv(connection);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run('pg_dump', ['--format=custom', '--no-owner', '--file', dest], { env });
  return fs.statSync(dest).size;
}

// ── Wiederherstellung (nur über die bestätigte Restore-Aktion) ──

/** Bestehende Dateien zur Seite legen, damit ein Restore sie nicht unwiederbringlich überschreibt. */
function setAside(preDir: string, label: string, files: string[]): void {
  fs.mkdirSync(path.join(preDir, label), { recursive: true });
  for (const f of files) {
    if (fs.existsSync(f)) fs.renameSync(f, path.join(preDir, label, path.basename(f)));
  }
}

export function restoreSqlite(bundleFile: string, target: string, preDir: string, id: string): void {
  if (!fs.existsSync(bundleFile)) throw new AppError('NOT_FOUND', `Im Backup fehlt ${path.basename(bundleFile)}`);
  setAside(preDir, id, [target, `${target}-wal`, `${target}-shm`]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(bundleFile, target);
}

export async function restoreDirectory(bundleFile: string, target: string, preDir: string, id: string): Promise<void> {
  if (!fs.existsSync(bundleFile)) throw new AppError('NOT_FOUND', `Im Backup fehlt ${path.basename(bundleFile)}`);
  const aside = path.join(preDir, id, path.basename(target));
  fs.mkdirSync(path.dirname(aside), { recursive: true });
  const hadTarget = fs.existsSync(target);
  if (hadTarget) fs.renameSync(target, aside);
  try {
    await run('tar', ['-xzf', bundleFile, '-C', path.dirname(target)]);
  } catch (err) {
    // Zustand vor dem Restore wiederherstellen
    fs.rmSync(target, { recursive: true, force: true });
    if (hadTarget) fs.renameSync(aside, target);
    throw err;
  }
}

export async function restorePostgres(bundleFile: string, connection: string): Promise<void> {
  if (!fs.existsSync(bundleFile)) throw new AppError('NOT_FOUND', `Im Backup fehlt ${path.basename(bundleFile)}`);
  const { env, database } = pgEnv(connection);
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', database, bundleFile], { env });
}
