import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '@devdeck/shared';
import type { AppContext } from './context.js';
import { handleError, sendError } from './http.js';
import { apiRoutes } from './routes/index.js';

/** Komponiert die komplette DevDeck-Server-App (testbar ohne listen()). */
export function createApp(ctx: AppContext): Express {
  const { config } = ctx;
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '2mb' }));

  // Einfache Security-Header (ohne externe Dependency)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', name: 'devdeck', time: new Date().toISOString() } });
  });

  app.use('/api', apiRoutes(ctx));

  // Unbekannte API-Routen sauber 404
  app.use('/api', (_req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'API-Endpunkt nicht gefunden');
  });

  // Statische Web UI
  app.use(express.static(config.webuiDir, { index: 'index.html', extensions: ['html'] }));

  // Zentraler Fehlerhandler (AppError → Envelope, sonst 500 ohne Stack)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      handleError(res, err);
      return;
    }
    // JSON-Parse-Fehler etc.
    const anyErr = err as { type?: string; status?: number; message?: string };
    if (anyErr?.type === 'entity.parse.failed') {
      sendError(res, 400, 'BAD_REQUEST', 'Ungültiges JSON');
      return;
    }
    handleError(res, err);
  });

  return app;
}
