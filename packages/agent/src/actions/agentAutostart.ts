import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { getAutostart, setAutostart } from '../autostart.js';
import { log } from '../logger.js';

/**
 * agent.autostart – nimmt den Agent in den Autostart der Maschine auf oder heraus
 * (Windows: Run-Schlüssel des Benutzers, Linux: systemd-Benutzerdienst, macOS: LaunchAgent).
 * Ohne `enabled` wird nur der Zustand gemeldet. Der laufende Agent wird dabei nie gestoppt oder doppelt gestartet.
 */
registerAction('agent.autostart', async ({ payload }) => {
  if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
    throw new AppError('VALIDATION', 'enabled muss true oder false sein');
  }
  const state = typeof payload.enabled === 'boolean' ? await setAutostart(payload.enabled) : await getAutostart();
  if (typeof payload.enabled === 'boolean') log.info(`Autostart ${state.enabled ? 'eingeschaltet' : 'ausgeschaltet'} (${state.method})`);
  return { ...state };
});
