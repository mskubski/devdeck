import type { AgentConfig } from './config.js';
import { ServerClient } from './client.js';
import { log } from './logger.js';

/** Heartbeat-Loop: hält die Maschine online (Spezifikation: alle ~30 s). */
export function startHeartbeat(
  config: AgentConfig,
  options: {
    intervalMs?: number;
    collectWorkspaces?: () => unknown[];
  } = {},
): { stop(): void } {
  const client = new ServerClient(config);
  const intervalMs = options.intervalMs ?? 30_000;
  let stopped = false;

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const workspaces = options.collectWorkspaces ? options.collectWorkspaces() : [];
      await client.heartbeat(workspaces);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Heartbeat fehlgeschlagen: ${message}`);
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
