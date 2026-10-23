/**
 * DevDeck System-Restore – ausschließlich interaktiv im Terminal.
 *
 * Bewusst KEINE API-/UI-Funktion: Ein Restore überschreibt Produktivdaten und braucht
 * einen Menschen, der den Backup-Zeitstempel und das Wort RESTORE eintippt.
 *
 *   node packages/server/dist/restore.js <backup-verzeichnis>
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { loadVaultKey } from './vault/vault.js';
import { verifyBundle, type BackupManifest } from './services/backups.js';

export interface RestoreResult {
  safetyCopyDir: string;
  restored: string[];
}

/** Dateioperation (ohne Rückfrage) – wird nur nach erfolgreicher Bestätigung aufgerufen. */
export function applyBundle(bundleDir: string, dataDir: string): RestoreResult {
  const check = verifyBundle(bundleDir);
  if (!check.ok) throw new Error(`Backup ist beschädigt: ${check.problems.join('; ')}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyCopyDir = path.join(dataDir, `pre-restore-${stamp}`);
  fs.mkdirSync(safetyCopyDir, { recursive: true, mode: 0o700 });
  const targets: Array<{ from: string; to: string }> = [
    { from: 'devdeck.db', to: path.join(dataDir, 'devdeck.db') },
    { from: 'vault.db', to: path.join(dataDir, 'vault', 'vault.db') },
  ];
  const restored: string[] = [];
  for (const t of targets) {
    const src = path.join(bundleDir, t.from);
    if (!fs.existsSync(src)) continue;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(t.to + suffix)) {
        fs.renameSync(t.to + suffix, path.join(safetyCopyDir, path.basename(t.to) + suffix));
      }
    }
    fs.mkdirSync(path.dirname(t.to), { recursive: true });
    fs.copyFileSync(src, t.to);
    restored.push(t.from);
  }
  return { safetyCopyDir, restored };
}

async function serverIsRunning(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const bundleDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (!bundleDir) {
    console.error('Aufruf: node dist/restore.js <backup-verzeichnis>');
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    console.error('Restore läuft nur interaktiv in einem Terminal (kein Skript-/Pipe-Betrieb).');
    process.exit(2);
  }
  const config = loadConfig();
  if (await serverIsRunning(config.port)) {
    console.error(`Ein DevDeck-Server läuft auf Port ${config.port}. Bitte zuerst stoppen.`);
    process.exit(1);
  }
  const check = verifyBundle(bundleDir);
  if (!check.ok) {
    console.error('Backup-Prüfung fehlgeschlagen:\n - ' + check.problems.join('\n - '));
    process.exit(1);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundleDir, 'backup_manifest.json'), 'utf8'),
  ) as BackupManifest;

  console.log(`Backup:          ${bundleDir}`);
  console.log(`Erstellt:        ${manifest.created_at}`);
  console.log(`Ziel-Datenordner: ${config.dataDir}`);
  console.log('Die aktuellen DB-Dateien werden in einen pre-restore-Ordner verschoben, dann ersetzt.');
  try {
    const current = loadVaultKey(config.vaultKeyPath, process.env.DEVDECK_VAULT_KEY ?? null);
    if (manifest.vault_key_id && current.keyId !== manifest.vault_key_id) {
      console.warn(
        `WARNUNG: Aktueller Vault-Key (${current.keyId}) passt nicht zum Backup (${manifest.vault_key_id}).`,
      );
    }
  } catch {
    console.warn('WARNUNG: Kein lesbarer Vault-Key gefunden – Secrets bleiben ohne Key unlesbar.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const stamp = await rl.question(`Zur Bestätigung den Backup-Zeitstempel eingeben (${manifest.created_at}): `);
  if (stamp.trim() !== manifest.created_at) {
    rl.close();
    console.error('Zeitstempel stimmt nicht – abgebrochen.');
    process.exit(1);
  }
  const word = await rl.question('Zum Ausführen das Wort RESTORE eingeben: ');
  rl.close();
  if (word.trim() !== 'RESTORE') {
    console.error('Abgebrochen.');
    process.exit(1);
  }
  const result = applyBundle(bundleDir, config.dataDir);
  console.log(`Wiederhergestellt: ${result.restored.join(', ')}`);
  console.log(`Vorherige Dateien gesichert unter: ${result.safetyCopyDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Restore fehlgeschlagen:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
