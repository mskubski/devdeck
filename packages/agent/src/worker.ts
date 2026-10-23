import { isAgentAction, type AgentCommandPayload } from '@devdeck/shared';
import type { AgentConfig } from './config.js';
import { ServerClient } from './client.js';
import { getAction } from './actions/index.js';
import { log } from './logger.js';

/**
 * Command-Worker: holt Aufträge per Long-Poll und führt ausschließlich
 * allowlistete Aktionen aus. Fehler werden strukturiert zurückgemeldet.
 */
export function startWorker(config: AgentConfig, options: { pollSeconds?: number } = {}): {
  stop(): void;
} {
  const client = new ServerClient(config);
  const pollSeconds = options.pollSeconds ?? 25;
  let stopped = false;

  const execute = async (command: AgentCommandPayload): Promise<void> => {
    const target = typeof command.payload?.local_path === 'string' ? ` (${command.payload.local_path})` : '';
    log.info(`Befehl ${command.action}${target} empfangen [${command.id}]`);
    if (!isAgentAction(command.action)) {
      log.error(`Befehl ${command.id}: Aktion nicht erlaubt: ${command.action}`);
      await client.sendResult(command.id, {
        status: 'failed',
        error: { code: 'VALIDATION', message: `Aktion nicht erlaubt: ${command.action}` },
      });
      return;
    }
    const handler = getAction(command.action);
    if (!handler) {
      log.error(`Befehl ${command.id}: Aktion nicht implementiert: ${command.action}`);
      await client.sendResult(command.id, {
        status: 'failed',
        error: { code: 'INTERNAL', message: `Aktion nicht implementiert: ${command.action}` },
      });
      return;
    }
    try {
      const started = Date.now();
      const data = await handler({ client, payload: command.payload, config });
      log.info(`Befehl ${command.action} erfolgreich (${Date.now() - started} ms) [${command.id}]`);
      await client.sendResult(command.id, { status: 'done', data });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Befehl ${command.action} fehlgeschlagen [${command.id}]: ${code}: ${message}`);
      await client.sendResult(command.id, {
        status: 'failed',
        error: { code, message },
      });
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const commands = await client.pollCommands(pollSeconds);
        for (const command of commands) {
          if (stopped) break;
          await execute(command);
        }
      } catch (err) {
        if (stopped) break;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Command-Poll-Fehler: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  };

  void loop();
  return {
    stop() {
      stopped = true;
    },
  };
}
