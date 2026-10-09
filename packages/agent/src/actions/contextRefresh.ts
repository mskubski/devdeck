import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';

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

  const target = path.join(workspacePath, '.devdeck');
  fs.mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(res.data)) {
    if (!/^[A-Z_]+\.md$/.test(name)) continue; // nur erwartete Kontextdateien
    fs.writeFileSync(path.join(target, name), content, 'utf8');
    written.push(name);
  }
  fs.mkdirSync(path.join(target, 'handover'), { recursive: true });
  return { local_path: workspacePath, files: written };
});
