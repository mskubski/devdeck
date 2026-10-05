import type { ServerConfig } from './config.js';
import type { Database } from './db/database.js';

/** Gemeinsamer Kontext, der an alle Route-Factories übergeben wird. */
export interface AppContext {
  db: Database;
  config: ServerConfig;
  /** Spät gebunden (Phase G), damit App bereits ohne Vault testbar ist. */
  vault?: import('./vault/vault.js').VaultService;
}
