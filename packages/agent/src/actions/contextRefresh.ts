import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { writeContextFiles } from '../contextFiles.js';

/**
 * context.refresh – schreibt den vom Server erzeugten Coding-Kontext
 * nach `.devdeck/` (CONTEXT.md, CURRENT_STATE.md, CHANGELOG_RECENT.md, SECRETS.md).
 * SECRETS.md enthält niemals Werte (baut der Server so auf).
 */
registerAction('context.refresh', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const workspaceId =
    typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;

  const res = await ctx.client.request<Record<string, string>>(
    'POST',
    '/api/agent/context/write',
    { body: { workspace_id: workspaceId, local_path: workspacePath } },
  );
  if (res.status === 401 || res.status === 403) {
    throw new AppError('UNAUTHORIZED', res.error?.message ?? 'Kontextabruf nicht autorisiert');
  }
  if (res.status !== 200 || !res.data) {
    throw new AppError('NOT_FOUND', res.error?.message ?? 'Kein Kontext für dieses Projekt verfügbar');
  }

  const written = writeContextFiles(workspacePath, res.data);
  return { local_path: workspacePath, files: written };
});
