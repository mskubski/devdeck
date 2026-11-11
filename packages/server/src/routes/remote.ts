import { Router, type Request } from 'express';
import { AppError, agentSupportsAction } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { requireUser, type MachineRecord } from '../auth/middleware.js';
import { VaultService } from '../vault/vault.js';
import { asyncHandler, clientIp, param } from '../http.js';
import { audit } from '../services/audit.js';
import { enqueueCommand } from '../services/provisioning.js';
import { MAX_SESSIONS_PER_MACHINE, MAX_SESSIONS_TOTAL, activeSessionCount, createRemoteSession } from '../services/remoteRelay.js';

const COLUMNS = 'id, owner_user_id, name, platform, agent_version, agent_status, revoked_at, remote_json, remote_secret_ref';

/** Fernzugriff (VNC) je Maschine: erkennen, einrichten, Passwort hinterlegen, Sitzung öffnen. Nur Besitzer oder Admin. */
export function remoteRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  const load = (req: Request, action: 'detect' | 'open' | 'install' | 'none' = 'none'): MachineRecord => {
    const user = req.user!;
    const row = db.get<MachineRecord>(`SELECT ${COLUMNS} FROM machines WHERE id = ?`, param(req, 'id')!);
    if (!row) throw new AppError('NOT_FOUND', 'Maschine nicht gefunden');
    if (row.owner_user_id !== user.id && user.system_role !== 'admin') throw new AppError('FORBIDDEN', 'Nur Besitzer oder admin darf den Fernzugriff nutzen');
    if (action !== 'none') {
      if (row.revoked_at) throw new AppError('AGENT_OFFLINE', 'Maschine ist widerrufen');
      if (row.agent_status !== 'online') throw new AppError('AGENT_OFFLINE', 'Maschine ist nicht online');
      if (!agentSupportsAction(row.agent_version, `remote.${action}`)) {
        throw new AppError('VALIDATION', 'Dieser Agent kennt den Fernzugriff noch nicht – bitte zuerst den Agent aktualisieren (ab Version 0.19.0).');
      }
    }
    return row;
  };

  const record = (req: Request, action: string, machineId: string, detail: Record<string, unknown> = {}): void => {
    audit(db, {
      actor_type: 'user',
      actor_id: req.user!.id,
      actor_label: req.user!.email,
      action,
      machine_id: machineId,
      target_type: 'machine',
      target_id: machineId,
      result: 'success',
      detail,
      ip: clientIp(req),
    });
  };

  // VNC-Zustand neu prüfen lassen
  router.post(
    '/:id/remote/detect',
    asyncHandler(async (req, res) => {
      const m = load(req, 'detect');
      const commandId = enqueueCommand(db, { machineId: m.id, action: 'remote.detect', payload: {}, requestedBy: req.user!.id, ttlSeconds: 300 });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // VNC-Server auf der Maschine einrichten (das Passwort erzeugt der Agent; es landet verschlüsselt im Vault, nicht im Befehlsergebnis)
  router.post(
    '/:id/remote/install',
    asyncHandler(async (req, res) => {
      const m = load(req, 'install');
      if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist auf diesem Server nicht initialisiert');
      const commandId = enqueueCommand(db, { machineId: m.id, action: 'remote.install', payload: {}, requestedBy: req.user!.id, ttlSeconds: 900 });
      record(req, 'machine.remote.install', m.id, { command_id: commandId });
      res.status(202).json({ data: { command_id: commandId } });
    }),
  );

  // VNC-Passwort hinterlegen (verschlüsselt) oder entfernen; der Wert wird nie angezeigt
  router.put(
    '/:id/remote/password',
    asyncHandler(async (req, res) => {
      const m = load(req);
      if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist auf diesem Server nicht initialisiert');
      const value = req.body?.password;
      if (value === null || value === '') {
        db.run('UPDATE machines SET remote_secret_ref = NULL WHERE id = ?', m.id);
        record(req, 'machine.remote.password.clear', m.id);
        res.json({ data: { password_set: false } });
        return;
      }
      if (typeof value !== 'string' || value.length > 64) throw new AppError('VALIDATION', 'Passwort fehlt oder ist zu lang (höchstens 64 Zeichen)');
      const ref = ctx.vault.put(value, VaultService.aad(`machine:${m.id}`, 'remote', 'vnc', 1));
      db.run('UPDATE machines SET remote_secret_ref = ? WHERE id = ?', ref, m.id);
      record(req, 'machine.remote.password.set', m.id);
      res.json({ data: { password_set: true } });
    }),
  );

  // Sitzung öffnen: der Agent baut den Tunnel auf, der Browser verbindet sich danach per WebSocket (noVNC)
  router.post(
    '/:id/remote/sessions',
    asyncHandler(async (req, res) => {
      const m = load(req, 'open');
      let known: number | null | undefined = null;
      try {
        known = m.remote_json ? (JSON.parse(m.remote_json) as { vnc?: { port?: number | null } }).vnc?.port : null;
      } catch {
        known = null;
      }
      const port = Number.isInteger(req.body?.port) ? (req.body.port as number) : (known ?? 5900);
      if (port < 5900 || port > 5999) throw new AppError('VALIDATION', 'Port muss ein VNC-Port sein (5900–5999)');
      if (activeSessionCount(ctx, m.id) >= MAX_SESSIONS_PER_MACHINE || activeSessionCount(ctx) >= MAX_SESSIONS_TOTAL) {
        throw new AppError('VALIDATION', 'Zu viele offene Fernzugriff-Sitzungen – bitte eine beenden.');
      }
      const user = req.user!;
      const session = createRemoteSession(ctx, { machineId: m.id, userId: user.id, userLabel: user.email, port, ip: clientIp(req) });
      const commandId = enqueueCommand(db, {
        machineId: m.id,
        action: 'remote.open',
        payload: { session_id: session.id, token: session.agentToken, port },
        requestedBy: user.id,
        ttlSeconds: 60,
      });
      let password: string | null = null;
      if (m.remote_secret_ref && ctx.vault) {
        try {
          password = ctx.vault.getString(m.remote_secret_ref);
        } catch {
          password = null;
        }
      }
      res.status(201).json({ data: { session_id: session.id, command_id: commandId, ws_path: `/api/machines/${m.id}/remote/${session.id}/ws`, password } });
    }),
  );

  return router;
}
