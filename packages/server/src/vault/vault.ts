import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { Database } from '../db/database.js';

/**
 * DevDeck Vault (Entscheidung A5): AES-256-GCM, separate SQLite-Datei.
 * Speichert AUSSCHLIESSLICH verschlüsselte Blobs – Metadaten leben in devdeck.db.
 */
export interface VaultKeyInfo {
  key: Buffer;
  keyId: string;
  created: boolean;
}

export interface VaultServiceOptions {
  keyPath: string;
  /** Optional: Base64-32-Byte-Key aus der Umgebung (Außenführung). */
  envKey?: string | null;
}

/** Key laden bzw. initial erzeugen (Keyfile 0600). */
export function loadVaultKey(keyPath: string, envKey?: string | null): VaultKeyInfo {
  if (envKey) {
    const key = Buffer.from(envKey, 'base64');
    if (key.length !== 32) {
      throw new AppError('VAULT_ERROR', 'DEVDECK_VAULT_KEY muss 32 Bytes (base64) enthalten');
    }
    return { key, keyId: keyIdOf(key), created: false };
  }
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new AppError('VAULT_ERROR', `Vault-Keyfile ungültig: ${keyPath}`);
    }
    return { key, keyId: keyIdOf(key), created: false };
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return { key, keyId: keyIdOf(key), created: true };
}

function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

interface VaultRow {
  id: string;
  key_id: string;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  ciphertext: Uint8Array;
  aad: string;
  updated_at: string;
}

export class VaultService {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly keyId: string;
  readonly keyCreated: boolean;

  constructor(keyPath: string, envKey?: string | null) {
    const info = loadVaultKey(keyPath, envKey);
    this.#key = info.key;
    this.keyId = info.keyId;
    this.keyCreated = info.created;
    // Vault-DB-Datei liegt neben dem Keyfile (vault/Ordner)
    this.#db = new Database(path.join(path.dirname(keyPath), 'vault.db'));
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS vault_values (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        aad TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  static aad(projectId: string, name: string, environment: string, version: number): string {
    return `project:${projectId}:name:${name}:env:${environment}:v${version}`;
  }

  /** Wert verschlüsselt speichern; liefert vault_reference `v1:<keyId>:<rowId>`. */
  put(
    plaintext: Buffer | string,
    aad: string,
    id: string = randomUUID(),
  ): string {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO vault_values (id, key_id, iv, auth_tag, ciphertext, aad, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         key_id = excluded.key_id, iv = excluded.iv, auth_tag = excluded.auth_tag,
         ciphertext = excluded.ciphertext, aad = excluded.aad, updated_at = excluded.updated_at`,
      id,
      this.keyId,
      iv,
      authTag,
      ciphertext,
      aad,
      now,
    );
    return `v1:${this.keyId}:${id}`;
  }

  /** Wert entschlüsseln; Manipulation/falscher Key → VAULT_ERROR. */
  get(reference: string): Buffer {
    const row = this.#parseRef(reference);
    if (row.key_id !== this.keyId) {
      throw new AppError(
        'VAULT_ERROR',
        'Vault-Key stimmt nicht mit dem Key des Eintrags überein (Key-Wechsel/Verlust?)',
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(row.iv));
      decipher.setAAD(Buffer.from(row.aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(row.auth_tag));
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
    } catch {
      throw new AppError('VAULT_ERROR', 'Vault-Eintrag konnte nicht authentifiziert werden');
    }
  }

  getString(reference: string): string {
    return this.get(reference).toString('utf8');
  }

  has(reference: string): boolean {
    try {
      this.#parseRef(reference);
      return true;
    } catch {
      return false;
    }
  }

  delete(reference: string): void {
    const row = this.#parseRef(reference);
    this.#db.run('DELETE FROM vault_values WHERE id = ?', row.id);
  }

  #parseRef(reference: string): VaultRow {
    const match = /^v1:([0-9a-f]{16}):(.+)$/.exec(reference);
    if (!match) throw new AppError('VAULT_ERROR', 'Ungültige vault_reference');
    const row = this.#db.get<VaultRow>(
      `SELECT id, key_id, iv, auth_tag, ciphertext, aad, updated_at
       FROM vault_values WHERE id = ?`,
      match[2],
    );
    if (!row) throw new AppError('VAULT_ERROR', 'Vault-Eintrag nicht gefunden');
    return row;
  }

  close(): void {
    this.#db.close();
  }
}
