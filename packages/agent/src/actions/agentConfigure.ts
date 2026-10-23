import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { saveAgentConfig } from '../config.js';
import { log } from '../logger.js';

/**
 * agent.configure – ändert den Workspace-Root des Agenten zur Laufzeit und
 * speichert ihn in der Agent-Konfiguration. Wirkt sofort (kein Neustart nötig).
 */
registerAction('agent.configure', async (ctx) => {
  const raw = ctx.payload.workspace_root;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('VALIDATION', 'workspace_root ist erforderlich');
  }
  if (!path.isAbsolute(raw.trim())) {
    throw new AppError('VALIDATION', `workspace_root muss ein absoluter Pfad sein: ${raw}`);
  }
  const root = path.resolve(raw.trim());
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    throw new AppError(
      'VALIDATION',
      `Verzeichnis ${root} existiert nicht und konnte nicht angelegt werden: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const previous = ctx.config.workspaceRoot;
  ctx.config.workspaceRoot = root;
  saveAgentConfig(ctx.config);
  log.info(`Workspace-Root geändert: ${previous} -> ${root}`);
  return { workspace_root: root, previous_workspace_root: previous };
});
