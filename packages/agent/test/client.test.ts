import { describe, expect, it } from 'vitest';
import { ServerClient } from '../src/client.js';
import type { AgentConfig } from '../src/config.js';

const config = (serverUrl: string): AgentConfig => ({
  serverUrl, machineId: null, machineToken: null, localToken: 'x', workspaceRoot: '/tmp', localPort: 0, agentVersion: '0.0.0',
});

describe('ServerClient Verbindungsfehler', () => {
  it('meldet abgelehnte Verbindung verständlich mit URL', async () => {
    const client = new ServerClient(config('http://127.0.0.1:1'));
    await expect(client.enroll('tok', 'pc')).rejects.toMatchObject({
      code: 'AGENT_OFFLINE',
      message: expect.stringMatching(/Server nicht erreichbar: http:\/\/127\.0\.0\.1:1 – Verbindung abgelehnt/),
    });
  });

  it('meldet nicht auflösbare Hostnamen', async () => {
    const client = new ServerClient(config('http://gibt-es-nicht.invalid:8080'));
    await expect(client.request('GET', '/api/health', { auth: 'none', timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'AGENT_OFFLINE',
      message: expect.stringContaining('Server nicht erreichbar'),
    });
  });
});
