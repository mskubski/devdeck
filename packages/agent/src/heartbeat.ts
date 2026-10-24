import type { AgentConfig } from './config.js';
import { ServerClient } from './client.js';
import { log } from './logger.js';
import { collectInventory } from './inventory.js';
import { collectApplications } from './applications.js';
import { collectPatches } from './patches.js';
import { collectLogs } from './logs.js';
import type { MachineApplication, MachineInventory, MachineLogEntry, MachinePatches } from '@devdeck/shared';

/** Heartbeat-Loop: hält die Maschine online (Spezifikation: alle ~30 s). */
export function startHeartbeat(
  config: AgentConfig,
  options: {
    intervalMs?: number;
    collectWorkspaces?: () => unknown[];
    /** Austauschbar für Tests; Standard: echtes Inventar (alle 15 Minuten neu). */
    collectInventory?: () => Promise<MachineInventory>;
    inventoryIntervalMs?: number;
    /** Installierte Software: Standard echt, stündlich neu. */
    collectApplications?: () => Promise<MachineApplication[]>;
    applicationsIntervalMs?: number;
    /** Patch-Stand: Standard echt, alle 6 Stunden neu (die Prüfung fragt Update-Dienste im Netz ab). */
    collectPatches?: () => Promise<MachinePatches>;
    patchesIntervalMs?: number;
    /** Fehlerprotokolle seit `since`; Standard echt, alle 15 Minuten (beim ersten Mal die letzten 7 Tage). */
    collectLogs?: (since: Date) => Promise<{ entries: MachineLogEntry[]; notes: string[] }>;
    logsIntervalMs?: number;
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

  const gatherApps = options.collectApplications ?? collectApplications;
  const appsEveryMs = options.applicationsIntervalMs ?? 60 * 60_000;
  let pendingApps: { collected_at: string; items: MachineApplication[] } | null = null;
  const refreshApplications = async (): Promise<void> => {
    try {
      pendingApps = { collected_at: new Date().toISOString(), items: await gatherApps() };
    } catch (err) {
      log.warn(`Software-Liste nicht ermittelbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const gatherPatches = options.collectPatches ?? collectPatches;
  const patchesEveryMs = options.patchesIntervalMs ?? 6 * 60 * 60_000;
  let pendingPatches: MachinePatches | null = null;
  const refreshPatches = async (): Promise<void> => {
    try {
      pendingPatches = await gatherPatches();
    } catch (err) {
      log.warn(`Patch-Stand nicht ermittelbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const gatherLogs = options.collectLogs ?? collectLogs;
  const logsEveryMs = options.logsIntervalMs ?? 15 * 60_000;
  let pendingLogs: { collected_at: string; entries: MachineLogEntry[]; notes: string[] } | null = null;
  let logsSince = new Date(Date.now() - 7 * 86_400_000);
  const refreshLogs = async (): Promise<void> => {
    try {
      const startedAt = new Date();
      const r = await gatherLogs(logsSince);
      // Was noch nicht übertragen wurde, bleibt erhalten (der Server ignoriert Doppelte)
      pendingLogs = { collected_at: startedAt.toISOString(), entries: [...(pendingLogs?.entries ?? []), ...r.entries].slice(-600), notes: r.notes };
      logsSince = new Date(startedAt.getTime() - 60_000); // eine Minute Überlappung gegen Lücken
    } catch (err) {
      log.warn(`Logs nicht lesbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const workspaces = options.collectWorkspaces ? options.collectWorkspaces() : [];
      const sending = pending;
      const sendingApps = pendingApps;
      const sendingPatches = pendingPatches;
      const sendingLogs = pendingLogs;
      await client.heartbeat(workspaces, sending ?? undefined, sendingApps ?? undefined, sendingPatches ?? undefined, sendingLogs ?? undefined);
      if (sendingLogs && pendingLogs === sendingLogs) pendingLogs = null;
      if (sendingPatches && pendingPatches === sendingPatches) pendingPatches = null;
      if (sending && pending === sending) pending = null;
      if (sendingApps && pendingApps === sendingApps) pendingApps = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Heartbeat fehlgeschlagen: ${message}`);
    }
  };

  void beat(); // sofort online melden; das Inventar folgt, sobald es gesammelt ist
  void refreshInventory().then(() => refreshApplications()).then(() => refreshLogs()).then(() => refreshPatches()); // nacheinander: zwei PowerShell-Prozesse gleichzeitig belasten den Start unnötig
  const timer = setInterval(() => void beat(), intervalMs);
  const inventoryTimer = setInterval(() => void refreshInventory(), inventoryEveryMs);
  const appsTimer = setInterval(() => void refreshApplications(), appsEveryMs);
  appsTimer.unref?.();
  const patchesTimer = setInterval(() => void refreshPatches(), patchesEveryMs);
  patchesTimer.unref?.();
  const logsTimer = setInterval(() => void refreshLogs(), logsEveryMs);
  logsTimer.unref?.();
  timer.unref?.();
  inventoryTimer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(inventoryTimer);
      clearInterval(appsTimer);
      clearInterval(patchesTimer);
      clearInterval(logsTimer);
    },
  };
}
