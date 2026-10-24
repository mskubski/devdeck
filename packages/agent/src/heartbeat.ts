import type { AgentConfig } from './config.js';
import { ServerClient } from './client.js';
import { log } from './logger.js';
import { collectInventory } from './inventory.js';
import type { MachineInventory } from '@devdeck/shared';

/** Heartbeat-Loop: hält die Maschine online (Spezifikation: alle ~30 s). */
export function startHeartbeat(
  config: AgentConfig,
  options: {
    intervalMs?: number;
    collectWorkspaces?: () => unknown[];
    /** Austauschbar für Tests; Standard: echtes Inventar (alle 15 Minuten neu). */
    collectInventory?: () => Promise<MachineInventory>;
    inventoryIntervalMs?: number;
  } = {},
): { stop(): void } {
  const client = new ServerClient(config);
  const intervalMs = options.intervalMs ?? 30_000;
  let stopped = false;

  // Inventar: beim Start und danach alle 15 Minuten neu sammeln; mitgeschickt wird es mit dem nächsten Heartbeat,
  // und bei einem Fehlschlag so lange erneut, bis der Server es angenommen hat.
  const gather = options.collectInventory ?? collectInventory;
  const inventoryEveryMs = options.inventoryIntervalMs ?? 15 * 60_000;
  let pending: MachineInventory | null = null;
  const refreshInventory = async (): Promise<void> => {
    try {
      pending = await gather();
    } catch (err) {
      log.warn(`Inventar nicht ermittelbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const workspaces = options.collectWorkspaces ? options.collectWorkspaces() : [];
      const sending = pending;
      await client.heartbeat(workspaces, sending ?? undefined);
      if (sending && pending === sending) pending = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Heartbeat fehlgeschlagen: ${message}`);
    }
  };

  void beat(); // sofort online melden; das Inventar folgt, sobald es gesammelt ist
  void refreshInventory();
  const timer = setInterval(() => void beat(), intervalMs);
  const inventoryTimer = setInterval(() => void refreshInventory(), inventoryEveryMs);
  timer.unref?.();
  inventoryTimer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(inventoryTimer);
    },
  };
}
