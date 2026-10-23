import type { Database } from '../db/database.js';

export function getSetting(db: Database, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    new Date().toISOString(),
  );
}
