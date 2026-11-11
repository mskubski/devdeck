import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Request } from 'express';
import type { AppContext } from '../context.js';
import { currentUser } from '../auth/middleware.js';
import { audit } from './audit.js';

/**
 * Fernzugriff: DevDeck-Server als Vermittler zwischen dem Browser (noVNC) und dem Agent der Maschine.
 * Der Agent baut die Verbindung ausgehend auf (kein Port muss auf der Maschine erreichbar sein); der Server reicht die Bytes
 * des VNC-Protokolls unverändert durch. Der Server wertet den Datenstrom nie aus und speichert ihn nicht.
 */

const PAIR_TIMEOUT_MS = 60_000;
const MAX_LIFETIME_MS = 12 * 60 * 60_000;
const QUEUE_MAX_BYTES = 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
export const MAX_SESSIONS_PER_MACHINE = 3;
export const MAX_SESSIONS_TOTAL = 20;

export interface RemoteSession {
  id: string;
  machineId: string;
  userId: string;
  userLabel: string;
  port: number;
  agentToken: string | null;
  createdAt: number;
  agent: WebSocket | null;
  browser: WebSocket | null;
  toBrowser: Buffer[];
  toAgent: Buffer[];
  queued: number;
  paired: boolean;
  bytes: number;
  ended: boolean;
  ip: string | null;
}

class Relay {
  readonly sessions = new Map<string, RemoteSession>();
  readonly timer: NodeJS.Timeout;
  constructor(readonly ctx: AppContext) {
    this.timer = setInterval(() => this.sweep(), 5_000);
    this.timer.unref();
  }

  sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.ended) continue;
      if (!s.paired && now - s.createdAt > PAIR_TIMEOUT_MS) end(this, s, 'timeout');
      else if (now - s.createdAt > MAX_LIFETIME_MS) end(this, s, 'max-lifetime');
      else {
        for (const ws of [s.agent, s.browser]) if (ws && ws.readyState === ws.OPEN) ws.ping();
      }
    }
    for (const [id, s] of this.sessions) if (s.ended && now - s.createdAt > 5 * 60_000) this.sessions.delete(id);
  }
}

const relays = new WeakMap<AppContext, Relay>();
function relayFor(ctx: AppContext): Relay {
  let r = relays.get(ctx);
  if (!r) {
    r = new Relay(ctx);
    relays.set(ctx, r);
  }
  return r;
}

export function activeSessionCount(ctx: AppContext, machineId?: string): number {
  let n = 0;
  for (const s of relayFor(ctx).sessions.values()) if (!s.ended && (!machineId || s.machineId === machineId)) n += 1;
  return n;
}

export function createRemoteSession(ctx: AppContext, opts: { machineId: string; userId: string; userLabel: string; port: number; ip: string | null }): RemoteSession {
  const relay = relayFor(ctx);
  const session: RemoteSession = {
    id: randomUUID(),
    machineId: opts.machineId,
    userId: opts.userId,
    userLabel: opts.userLabel,
    port: opts.port,
    agentToken: randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    agent: null,
    browser: null,
    toBrowser: [],
    toAgent: [],
    queued: 0,
    paired: false,
    bytes: 0,
    ended: false,
    ip: opts.ip,
  };
  relay.sessions.set(session.id, session);
  return session;
}

/** Sitzung beenden (z. B. wenn der Agent den Tunnel nicht aufbauen konnte). */
export function endRemoteSession(ctx: AppContext, id: string, reason: string): void {
  const relay = relayFor(ctx);
  const s = relay.sessions.get(id);
  if (s) end(relay, s, reason);
}

function end(relay: Relay, s: RemoteSession, reason: string): void {
  if (s.ended) return;
  s.ended = true;
  s.agentToken = null;
  for (const ws of [s.agent, s.browser]) {
    try {
      ws?.close(1000, reason.slice(0, 100));
    } catch {
      /* schon zu */
    }
  }
  s.toBrowser = [];
  s.toAgent = [];
  try {
    audit(relay.ctx.db, {
      actor_type: 'user',
      actor_id: s.userId,
      actor_label: s.userLabel,
      action: 'machine.remote.end',
      machine_id: s.machineId,
      target_type: 'machine',
      target_id: s.machineId,
      result: s.paired ? 'success' : 'failure',
      detail: { session_id: s.id, reason, kb: Math.round(s.bytes / 1024), seconds: Math.round((Date.now() - s.createdAt) / 1000) },
      ip: s.ip,
    });
  } catch {
    /* Audit darf den Abbau nie verhindern */
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function forward(relay: Relay, s: RemoteSession, from: WebSocket, to: WebSocket | null, queue: Buffer[], data: RawData): void {
  const buf = toBuffer(data);
  s.bytes += buf.length;
  if (!to || to.readyState !== to.OPEN) {
    s.queued += buf.length;
    if (s.queued > QUEUE_MAX_BYTES) return end(relay, s, 'queue-overflow');
    queue.push(buf);
    return;
  }
  to.send(buf, { binary: true });
  if (to.bufferedAmount > HIGH_WATER) {
    from.pause();
    const t = setInterval(() => {
      if (s.ended || to.bufferedAmount < HIGH_WATER / 4) {
        clearInterval(t);
        if (!s.ended) from.resume();
      }
    }, 100);
    t.unref();
  }
}

function pairIfReady(relay: Relay, s: RemoteSession): void {
  if (s.paired || !s.agent || !s.browser) return;
  s.paired = true;
  s.agentToken = null; // der Token gilt nur für den Aufbau
  for (const b of s.toBrowser.splice(0)) s.browser.send(b, { binary: true });
  for (const b of s.toAgent.splice(0)) s.agent.send(b, { binary: true });
  s.queued = 0;
  audit(relay.ctx.db, {
    actor_type: 'user',
    actor_id: s.userId,
    actor_label: s.userLabel,
    action: 'machine.remote.start',
    machine_id: s.machineId,
    target_type: 'machine',
    target_id: s.machineId,
    result: 'success',
    detail: { session_id: s.id, port: s.port },
    ip: s.ip,
  });
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sameToken(a: string | null, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** WebSocket-Endpunkte am HTTP-Server anmelden: /api/agent/remote/:id (Agent) und /api/machines/:mid/remote/:id/ws (Browser). */
export function attachRemoteRelay(server: Server, ctx: AppContext): void {
  const relay = relayFor(ctx);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://devdeck.local');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    const agentMatch = /^\/api\/agent\/remote\/([0-9a-f-]{36})$/.exec(url.pathname);
    const browserMatch = /^\/api\/machines\/([^/]+)\/remote\/([0-9a-f-]{36})\/ws$/.exec(url.pathname);
    if (!agentMatch && !browserMatch) return reject(socket, 404, 'Not Found');

    if (agentMatch) {
      const s = relay.sessions.get(agentMatch[1]!);
      if (!s || s.ended || s.agent || !sameToken(s.agentToken, url.searchParams.get('token') ?? '')) return reject(socket, 401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => {
        s.agent = ws;
        ws.on('message', (data) => forward(relay, s, ws, s.browser, s.toBrowser, data));
        ws.on('close', () => end(relay, s, 'agent-closed'));
        ws.on('error', () => end(relay, s, 'agent-error'));
        pairIfReady(relay, s);
      });
      return;
    }

    // Browser: Anmeldung per Session-Cookie, dazu Herkunftsprüfung (Schutz vor fremden Webseiten, die sonst die Anmeldung mitnutzen könnten)
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* ungültig */
      }
      const allowed = [req.headers.host, ctx.config.trustProxy ? String(req.headers['x-forwarded-host'] ?? '') : ''].filter(Boolean);
      if (!allowed.includes(host)) return reject(socket, 403, 'Forbidden');
    }
    const user = currentUser(req as unknown as Request, ctx.db);
    const s = relay.sessions.get(browserMatch![2]!);
    if (!user || !s || s.ended || s.browser || s.userId !== user.id || s.machineId !== browserMatch![1]) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      s.browser = ws;
      ws.on('message', (data) => forward(relay, s, ws, s.agent, s.toAgent, data));
      ws.on('close', () => end(relay, s, 'browser-closed'));
      ws.on('error', () => end(relay, s, 'browser-error'));
      pairIfReady(relay, s);
    });
  });
}
