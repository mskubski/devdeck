import { githubConnector } from './github.js';
import type { Connector } from './types.js';

/** Registry. Weitere Dienste (GitLab, Supabase, Vercel, …) kommen hier als weiterer Eintrag dazu. */
const CONNECTORS: Connector[] = [githubConnector];

export function listConnectors(): Connector[] {
  return CONNECTORS;
}

export function getConnector(type: string): Connector | undefined {
  return CONNECTORS.find((c) => c.type === type);
}

export type { Connector, ConnectorCheckResult } from './types.js';
