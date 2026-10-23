import type { ServerConfig } from './config.js';
import type { Database } from './db/database.js';

/** Gemeinsamer Kontext, der an alle Route-Factories übergeben wird. */
export interface AppContext {
  db: Database;
  config: ServerConfig;
  /** Spät gebunden (Phase G), damit App bereits ohne Vault testbar ist. */
  /** Commit, aus dem der laufende Server-Prozess gestartet wurde (beim Start ermittelt) – erkennt „Code auf Platte ist neuer als der laufende Prozess“. */
  runningCommit?: string;
  /** Neustart nach Self-Update (Default: Exit 75 unter systemd). Für Tests austauschbar. */
  restart?: () => void;
  /** Für Konnektor-Tests austauschbar (Default: globales fetch). */
  fetch?: typeof fetch;
  vault?: import('./vault/vault.js').VaultService;
}
