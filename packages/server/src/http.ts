import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, type ErrorCode } from '@devdeck/shared';

/** Route-Parameter robust auslesen (Express 5 kann string|string[] liefern). */
export function param(req: Request, name: string): string | undefined {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Cookies ohne externe Dependency parsen. */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Bearer-Token aus Authorization-Header (Agent/CLI). */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token || null;
  }
  return null;
}

/** Fehler als DevDeck-Envelope ausgeben – ohne Stack im Response-Body. */
export function sendError(res: Response, status: number, code: ErrorCode | string, message: string, details?: unknown): void {
  res.status(status).json({
    error: details === undefined ? { code, message } : { code, message, details },
  });
}

export function handleError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    const body = err.toJSON();
    sendError(res, err.status, body.code, body.message, body.details);
    return;
  }
  const message = err instanceof Error ? err.message : 'Interner Fehler';
  sendError(res, 500, 'INTERNAL', message);
}

/** Async-Route-Wrapper: wirft Errors an den zentralen Error-Handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Pflichtfeld als string. */
export function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('VALIDATION', `Feld "${field}" ist ein erforderlicher String`);
  }
  return value;
}

export function optionalString(body: unknown, field: string, max = 10_000): string | null {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION', `Feld "${field}" muss ein String sein`);
  }
  if (value.length > max) {
    throw new AppError('VALIDATION', `Feld "${field}" ist zu lang (max. ${max})`);
  }
  return value;
}

export function optionalBoolean(body: unknown, field: string): boolean {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return value === true;
}

/** Destruktive Aktionen müssen explizit bestätigt werden (Spezifikation §28). */
export function requireConfirmation(body: unknown): void {
  if (!optionalBoolean(body, 'confirm')) {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      'Destruktive Aktion erfordert "confirm": true',
    );
  }
}

export function clientIp(req: Request): string | null {
  return req.socket.remoteAddress ?? null;
}
