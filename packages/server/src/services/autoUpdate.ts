import type { AppContext } from '../context.js';
import { audit } from './audit.js';
import { getSetting, setSetting } from './settings.js';
import { getUpdateState, getVersionInfo, startSelfUpdate } from './selfUpdate.js';

export interface AutoUpdateSettings {
  enabled: boolean;
  /** Stunde (0–23, Serverzeit), in der geprüft und ggf. aktualisiert wird. */
  hour: number;
}

export function getAutoUpdateSettings(ctx: AppContext): AutoUpdateSettings {
  const hour = Number(getSetting(ctx.db, 'auto_update_hour') ?? 3);
  return {
    enabled: getSetting(ctx.db, 'auto_update_enabled') === '1',
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3,
  };
}

export function saveAutoUpdateSettings(ctx: AppContext, s: AutoUpdateSettings): void {
  setSetting(ctx.db, 'auto_update_enabled', s.enabled ? '1' : '0');
  setSetting(ctx.db, 'auto_update_hour', String(s.hour));
}

export type AutoUpdateOutcome =
  | 'disabled' | 'wrong_hour' | 'already_checked' | 'busy' | 'unreachable' | 'up_to_date' | 'skipped_dirty' | 'started';

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Wird alle paar Minuten aufgerufen. Höchstens ein Versuch pro Tag, nur in der gewählten Stunde,
 * nur wenn `main` neuer ist, der Ordner sauber ist und gerade kein Agent-Auftrag läuft.
 */
export async function runAutoUpdateTick(ctx: AppContext, now: Date = new Date()): Promise<AutoUpdateOutcome> {
  const settings = getAutoUpdateSettings(ctx);
  if (!settings.enabled) return 'disabled';
  if (now.getHours() !== settings.hour) return 'wrong_hour';
  const today = localDay(now);
  if (getSetting(ctx.db, 'auto_update_last_check') === today) return 'already_checked';
  if (getUpdateState().state === 'running') return 'busy';
  if (ctx.db.get(`SELECT 1 FROM agent_commands WHERE status = 'running' LIMIT 1`)) return 'busy';

  const info = await getVersionInfo(ctx, true);
  if (info.fetch_error) return 'unreachable'; // später in derselben Stunde erneut versuchen

  setSetting(ctx.db, 'auto_update_last_check', today);
  if (info.behind === 0 && !info.on_other_branch) return 'up_to_date';
  if (info.dirty) {
    setSetting(ctx.db, 'last_update', JSON.stringify({
      at: now.toISOString(), by: 'automatisch', result: 'failed',
      detail: 'übersprungen: lokale Änderungen im Server-Ordner',
    }));
    audit(ctx.db, {
      actor_type: 'system', actor_label: 'auto-update', action: 'system.update.finish',
      target_type: 'system', result: 'failure', detail: { error: 'dirty working tree' },
    });
    return 'skipped_dirty';
  }
  startSelfUpdate(ctx, { id: null, label: 'auto-update', type: 'system' }, { agents: true });
  return 'started';
}
