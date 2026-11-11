import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { detectRemote, installVnc, inspectEnv, planInstall, probeVnc } from '../remote.js';
import { openTunnel } from '../remoteTunnel.js';
import { log } from '../logger.js';

/** remote.detect – prüft, ob ein VNC-Server läuft und was sich einrichten lässt. */
registerAction('remote.detect', async () => ({ remote: await detectRemote() }) as unknown as Record<string, unknown>);

/**
 * remote.install – richtet einen nur lokal erreichbaren VNC-Server mit zufälligem Passwort ein (Windows: TightVNC per winget,
 * Linux: x11vnc als systemd-Benutzerdienst). Das Passwort geht einmalig an den Server (Vault) und wird dort nie angezeigt, nur beim Verbinden genutzt.
 */
registerAction('remote.install', async () => {
  const env = await inspectEnv();
  const running = (await probeVnc(5900)) !== null;
  const outcome = await installVnc(undefined, { env, install: planInstall(env, running) });
  log.info(`VNC eingerichtet: ${outcome.detail}`);
  return { password: outcome.password, port: outcome.port, detail: outcome.detail, remote: await detectRemote() } as unknown as Record<string, unknown>;
});

/** remote.open – öffnet den Tunnel für eine Sitzung (ausgehend zum DevDeck-Server); nur zu VNC-Servern auf dieser Maschine. */
registerAction('remote.open', async ({ payload, config }) => {
  const { session_id: sessionId, token, port } = payload as { session_id?: unknown; token?: unknown; port?: unknown };
  if (typeof sessionId !== 'string' || typeof token !== 'string' || typeof port !== 'number') {
    throw new AppError('VALIDATION', 'session_id, token und port erforderlich');
  }
  await openTunnel({ serverUrl: config.serverUrl, sessionId, token, port });
  return { connected: true };
});
