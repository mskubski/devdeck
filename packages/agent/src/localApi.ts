import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { AGENT_ACTIONS, AppError } from '@devdeck/shared';
import type { AgentConfig } from './config.js';
import { actionNames, getAction } from './actions/index.js';
import { ServerClient } from './client.js';

/**
 * Lokale API des Agenten (nur 127.0.0.1) – dient der DevDeck CLI.
 * Authentifizierung über lokalen Token aus agent.json (Modus 0600).
 */
export function startLocalApi(config: AgentConfig): { server: http.Server; close(): Promise<void> } {
  if (!config.localToken) {
    config.localToken = randomBytes(24).toString('base64url');
  }
  const client = new ServerClient(config);

  const server = http.createServer((req, res) => {
    const respond = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = req.headers['x-devdeck-local-token'];
    const authorized = token === config.localToken;

    void (async () => {
      if (url.pathname === '/status' && req.method === 'GET') {
        respond(200, {
          enrolled: Boolean(config.machineToken),
          machine_id: config.machineId,
          server_url: config.serverUrl,
          workspace_root: config.workspaceRoot,
          actions: actionNames(),
          allowlist: AGENT_ACTIONS,
        });
        return;
      }

      if (!authorized) {
        respond(401, { error: { code: 'UNAUTHORIZED', message: 'Lokaler Token ungültig' } });
        return;
      }

      const match = /^\/actions\/([a-z_.]+)$/.exec(url.pathname);
      if (match && req.method === 'POST') {
        const action = match[1]!;
        if (!(AGENT_ACTIONS as readonly string[]).includes(action)) {
          respond(403, { error: { code: 'FORBIDDEN', message: `Aktion nicht erlaubt: ${action}` } });
          return;
        }
        const handler = getAction(action);
        if (!handler) {
          respond(501, {
            error: { code: 'INTERNAL', message: `Aktion nicht implementiert: ${action}` },
          });
          return;
        }
        let payload: Record<string, unknown> = {};
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) {
            const parsed = JSON.parse(raw) as { payload?: Record<string, unknown> };
            payload = parsed.payload ?? {};
          }
        } catch {
          respond(400, { error: { code: 'BAD_REQUEST', message: 'Ungültiges JSON' } });
          return;
        }
        try {
          const data = await handler({ client, payload, config });
          respond(200, { data });
        } catch (err) {
          const code = (err as AppError).code ?? 'INTERNAL';
          const message = err instanceof Error ? err.message : String(err);
          respond(500, { error: { code, message } });
        }
        return;
      }

      respond(404, { error: { code: 'NOT_FOUND', message: 'Unbekannter lokaler Endpunkt' } });
    })();
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
