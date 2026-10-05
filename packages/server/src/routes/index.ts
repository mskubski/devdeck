import { Router } from 'express';
import type { AppContext } from '../context.js';
import { requireUser } from '../auth/middleware.js';
import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { projectRoutes } from './projects.js';
import { auditRoutes } from './audit.js';

/** Alle authentifizierten DevDeck-API-Router unter /api montieren. */
export function apiRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();

  router.use('/auth', authRoutes(ctx));
  router.use('/users', requireUser(db), userRoutes(ctx));
  router.use('/projects', requireUser(db), projectRoutes(ctx));
  router.use('/audit', requireUser(db), auditRoutes(ctx));

  return router;
}
