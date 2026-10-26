import { registerAction } from './index.js';
import { installPatches } from '../patchInstall.js';
import { log } from '../logger.js';

/**
 * patches.install – installiert ausgewählte, ausstehende Updates (Betriebssystem und Programme).
 * Zulässig ist nur, was eine frische Patch-Prüfung als ausstehend meldet; die Kennungen werden streng geprüft und nie über eine Shell ausgeführt.
 * Ein Neustart wird nicht ausgelöst, nur gemeldet (`reboot_required`).
 */
registerAction('patches.install', async ({ payload }) => {
  const outcome = await installPatches(payload.ids);
  const ok = outcome.results.filter((r) => r.ok).length;
  log.info(`Patches installiert: ${ok}/${outcome.results.length} erfolgreich${outcome.reboot_required ? ', Neustart erforderlich (nicht ausgeführt)' : ''}`);
  return { results: outcome.results, reboot_required: outcome.reboot_required, patches: outcome.patches } as unknown as Record<string, unknown>;
});
