import net from 'node:net';
import { AppError } from '@devdeck/shared';
import { VNC_PORT_MAX, VNC_PORT_MIN } from './remote.js';
import { log } from './logger.js';

const MAX_LIFETIME_MS = 12 * 60 * 60_000;
const HIGH_WATER = 4 * 1024 * 1024;

export interface TunnelOptions {
  serverUrl: string;
  sessionId: string;
  token: string;
  port: number;
  /** Nur für Tests: anderer Lokalhost-Bereich */
  portRange?: [number, number];
}

/** http(s)://host → ws(s)://host */
export function wsBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '').replace(/^http/i, 'ws');
}

/**
 * Tunnel für eine Fernzugriff-Sitzung: verbindet den VNC-Server auf 127.0.0.1 mit dem DevDeck-Server (ausgehende WebSocket-Verbindung,
 * keine Portfreigabe nötig). Es wird nur zu VNC-Servern getunnelt: Port 5900–5999 und der Dienst muss sich mit „RFB …“ melden.
 * Gibt zurück, sobald die Verbindung steht; der Tunnel läuft danach im Hintergrund, bis eine Seite sich trennt.
 */
export async function openTunnel(opts: TunnelOptions): Promise<{ close(): void }> {
  const [lo, hi] = opts.portRange ?? [VNC_PORT_MIN, VNC_PORT_MAX];
  if (!Number.isInteger(opts.port) || opts.port < lo || opts.port > hi) {
    throw new AppError('VALIDATION', `Port ${opts.port} ist kein VNC-Port (erlaubt: ${lo}–${hi})`);
  }
  if (!/^[0-9a-f-]{20,40}$/.test(opts.sessionId) || !/^[A-Za-z0-9_-]{20,80}$/.test(opts.token)) {
    throw new AppError('VALIDATION', 'Ungültige Sitzungsdaten');
  }

  // 1) lokal verbinden und die RFB-Begrüßung abwarten (der VNC-Server spricht zuerst)
  const socket = net.connect({ host: '127.0.0.1', port: opts.port });
  socket.setNoDelay(true);
  const first = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new AppError('VALIDATION', `Auf Port ${opts.port} antwortet kein VNC-Server`)); }, 5000);
    socket.once('error', (e) => { clearTimeout(timer); reject(new AppError('VALIDATION', `Kein VNC-Server auf Port ${opts.port} (${(e as Error).message})`)); });
    socket.once('data', (buf) => { clearTimeout(timer); resolve(buf); });
  });
  if (!/^RFB \d{3}\.\d{3}\n/.test(first.toString('latin1', 0, 12))) {
    socket.destroy();
    throw new AppError('VALIDATION', `Auf Port ${opts.port} läuft kein VNC-Server – aus Sicherheitsgründen wird nur zu VNC getunnelt`);
  }

  // 2) ausgehende WebSocket-Verbindung zum DevDeck-Server
  const url = `${wsBase(opts.serverUrl)}/api/agent/remote/${opts.sessionId}?token=${encodeURIComponent(opts.token)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Verbindung zum DevDeck-Server abgelehnt')); }, { once: true });
    });
  } catch (err) {
    socket.destroy();
    try { ws.close(); } catch { /* schon zu */ }
    throw new AppError('AGENT_OFFLINE', `Tunnel zum DevDeck-Server nicht möglich: ${(err as Error).message}`);
  }

  let closed = false;
  let bytes = 0;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    clearInterval(drain);
    socket.destroy();
    try { ws.close(); } catch { /* schon zu */ }
    log.info(`Fernzugriff-Sitzung beendet (${Math.round(bytes / 1024)} KB übertragen)`);
  };
  const lifetime = setTimeout(close, MAX_LIFETIME_MS);
  lifetime.unref?.();
  // Rückstau: ist der WebSocket zu voll, wird das Lesen vom VNC-Server kurz angehalten
  const drain = setInterval(() => { if (socket.isPaused() && ws.bufferedAmount < HIGH_WATER / 4) socket.resume(); }, 100);
  drain.unref?.();

  ws.send(first);
  bytes += first.length;
  socket.on('data', (buf) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    bytes += buf.length;
    ws.send(buf);
    if (ws.bufferedAmount > HIGH_WATER) socket.pause();
  });
  ws.addEventListener('message', (ev) => {
    const d = ev.data as ArrayBuffer | string;
    if (typeof d === 'string') return;
    bytes += d.byteLength;
    socket.write(Buffer.from(d));
  });
  socket.on('close', close);
  socket.on('error', close);
  ws.addEventListener('close', close);
  ws.addEventListener('error', close);
  log.info(`Fernzugriff-Sitzung gestartet (VNC Port ${opts.port})`);
  return { close };
}
