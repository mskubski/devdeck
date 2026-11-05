import fs from 'node:fs';
import path from 'node:path';
import { AppError, BACKUP_MANIFEST_FILE, isReplicableBundleName, type TransferFile } from '@devdeck/shared';
import type { ServerClient } from '../client.js';
import { listFiles, safeJoin, sha256File } from './fsutil.js';
import { checkTargetDir } from './run.js';

/**
 * Replikation von Backups (Agent-Seite). Die Kopie läuft über den Server, weil Agenten nur ausgehende Verbindungen aufbauen:
 *  – export: Quell-Agent lädt ein Backup (alle Dateien, mit Prüfsumme) in den Zwischenspeicher des Servers,
 *  – import: Ziel-Agent holt es dort ab, prüft jede Datei und legt es atomar im Zielordner ab,
 *  – prune: Ziel-Agent spiegelt die Aufbewahrung – entfernt Backups, die es beim Primären nicht mehr gibt, und meldet, was vorhanden ist.
 */

const hasManifest = (dir: string): boolean => fs.existsSync(path.join(dir, BACKUP_MANIFEST_FILE));

/** Vollständige Backups im Ordner (Name passt, Manifest vorhanden; `.…partial` und fremde Ordner zählen nicht). */
export function listReplicaBundles(targetDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isReplicableBundleName(e.name) && hasManifest(path.join(targetDir, e.name)))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export interface PruneResult {
  present: string[];
  deleted: string[];
}

/** Backups löschen, die nicht in `keep` stehen (nur Ordner mit Backup-Namen und Manifest – alles andere bleibt unangetastet). */
export function pruneReplica(targetDirRaw: string, keep: string[], del: boolean): PruneResult {
  const targetDir = checkTargetDir(targetDirRaw);
  const wanted = new Set(keep);
  const deleted: string[] = [];
  if (del) {
    for (const name of listReplicaBundles(targetDir)) {
      if (wanted.has(name)) continue;
      fs.rmSync(path.join(targetDir, name), { recursive: true, force: true });
      deleted.push(name);
    }
  }
  return { present: listReplicaBundles(targetDir), deleted };
}

/** Quell-Agent: Backup in den Zwischenspeicher des Servers hochladen. */
export async function exportBundle(client: ServerClient, p: { replicaId: string; targetDir: string; bundle: string }): Promise<{ files: number; bytes: number }> {
  if (!isReplicableBundleName(p.bundle)) throw new AppError('VALIDATION', 'Ungültiger Backup-Name');
  const dir = safeJoin(checkTargetDir(p.targetDir), p.bundle);
  if (!fs.existsSync(dir) || !hasManifest(dir)) throw new AppError('NOT_FOUND', `Backup ${p.bundle} liegt nicht (mehr) im Ordner ${p.targetDir}`);
  const files: TransferFile[] = [];
  const base = `/api/agent/replicas/${encodeURIComponent(p.replicaId)}/staging/${encodeURIComponent(p.bundle)}`;
  for (const rel of listFiles(dir).sort()) {
    const full = path.join(dir, rel);
    const bytes = fs.statSync(full).size;
    const sha256 = await sha256File(full);
    await client.putFile(`${base}/file?path=${encodeURIComponent(rel)}`, full, sha256, bytes);
    files.push({ path: rel, sha256, bytes });
  }
  const res = await client.request('POST', `${base}/complete`, { body: { files }, timeoutMs: 60_000 });
  if (res.status !== 200) throw new AppError('INTERNAL', res.error?.message ?? `Übergabe nicht bestätigt (HTTP ${res.status})`);
  return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** Ziel-Agent: Backup vom Server holen, jede Datei prüfen und atomar im Zielordner ablegen. */
export async function importBundle(client: ServerClient, p: { replicaId: string; targetDir: string; bundle: string }): Promise<{ files: number; bytes: number; skipped: boolean }> {
  if (!isReplicableBundleName(p.bundle)) throw new AppError('VALIDATION', 'Ungültiger Backup-Name');
  const targetDir = checkTargetDir(p.targetDir);
  const final = safeJoin(targetDir, p.bundle);
  if (hasManifest(final)) return { files: 0, bytes: 0, skipped: true }; // schon vollständig vorhanden

  const base = `/api/agent/replicas/${encodeURIComponent(p.replicaId)}/bundles/${encodeURIComponent(p.bundle)}`;
  const list = await client.request<{ files: TransferFile[] }>('GET', `${base}/files`, { timeoutMs: 120_000 });
  if (list.status !== 200 || !list.data) throw new AppError('INTERNAL', list.error?.message ?? `Dateiliste nicht verfügbar (HTTP ${list.status})`);
  const files = list.data.files;
  if (!files.some((f) => f.path === BACKUP_MANIFEST_FILE)) throw new AppError('INTERNAL', 'Das Backup enthält kein Manifest');

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const partial = path.join(targetDir, `.${p.bundle}.partial`);
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    // Zuerst alle Dateien, das Manifest zuletzt – es kennzeichnet ein vollständiges Backup
    const ordered = [...files.filter((f) => f.path !== BACKUP_MANIFEST_FILE), ...files.filter((f) => f.path === BACKUP_MANIFEST_FILE)];
    for (const f of ordered) {
      const dest = safeJoin(partial, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await client.getFile(`${base}/file?path=${encodeURIComponent(f.path)}`, dest, f);
    }
    fs.renameSync(partial, final);
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), skipped: false };
}
