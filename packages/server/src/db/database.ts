/**
 * Dünner SQLite-Wrapper um `node:sqlite` (Entscheidung A2).
 * Diese Datei ist die EINZIGE Stelle im gesamten DevDeck, die `node:sqlite` importiert.
 * Dadurch ist ein späterer Wechsel auf z. B. better-sqlite3 auf eine Datei begrenzt.
 */
import './warningGuard.js';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Booleans/undefined für node:sqlite normalisieren (nimmt keine Booleans). */
export function sqlBool(value: unknown): number {
  return value ? 1 : 0;
}

export function sqlValue(value: unknown): SqlParam {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  // Fallback: Objekte/Arrays werden als JSON-String persistiert (bewusst, dokumentiert)
  return JSON.stringify(value);
}

export class Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(readonly path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
  }

  get raw(): DatabaseSync {
    return this.#db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.#prepare(sql).get(...params.map(sqlValue)) as T | undefined;
    return row;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.#prepare(sql).all(...params.map(sqlValue)) as T[];
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const result = this.#prepare(sql).run(...params.map(sqlValue));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  /** Einfache Transaktion (verschachtelbar über internes Tiefenzähler-Prinzip: BEGIN IMMEDIATE). */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      // Verschachtelung: kein zusätzliches BEGIN – SQLite-Savepoint-Verhalten reicht für
      // unsere Zwecke nicht aus, daher serialized Ausführung erwartet (Single-Thread-Server).
      this.#depth += 1;
      try {
        const out = fn();
        this.#depth -= 1;
        return out;
      } catch (err) {
        this.#depth -= 1;
        throw err;
      }
    }
    this.#db.exec('BEGIN IMMEDIATE;');
    this.#depth = 1;
    try {
      const out = fn();
      this.#db.exec('COMMIT;');
      this.#depth = 0;
      return out;
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK;');
      } catch {
        /* ROLLBACK-Fehler ignorieren, ursprünglichen Fehler weiterreichen */
      }
      this.#depth = 0;
      throw err;
    }
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}
