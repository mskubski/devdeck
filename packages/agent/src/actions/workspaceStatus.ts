import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction, type ActionContext } from './index.js';
import { loadManifest } from '../manifest.js';
import { gitStatus, isGitRepo, git } from '../git.js';
import { buildReadiness } from '../readiness.js';

/** Resolve und sicherstellen, dass der Pfad im erlaubten Workspace-Root liegt. */
export function resolveWorkspacePath(ctx: ActionContext, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new AppError('VALIDATION', 'local_path ist erforderlich');
  }
  const root = path.resolve(ctx.config.workspaceRoot);
  const resolved = path.resolve(rawPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError(
      'FORBIDDEN',
      `Pfad liegt außerhalb des Workspace-Root (${root}) – Aktion abgelehnt`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new AppError('NOT_FOUND', `Workspace-Verzeichnis existiert nicht: ${resolved}`);
  }
  return resolved;
}

registerAction('workspace.status', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const manifest = loadManifest(workspacePath);
  const repo = await isGitRepo(workspacePath);
  const gitState = repo ? await gitStatus(workspacePath) : null;
  const gitProbe = await git(workspacePath, ['--version'], 5_000);
  const readiness = await buildReadiness({
    workspacePath,
    manifest,
    gitState,
    isRepo: repo,
    gitAvailable: gitProbe.code === 0,
  });

  const workspaceId =
    typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;

  // Status zusätzlich beim Server hinterlegen (falls Workspace bekannt)
  if (workspaceId) {
    await ctx.client.request('POST', `/api/agent/workspaces/${workspaceId}/status`, {
      body: {
        git: gitState,
        readiness,
        manifest: manifest ? { project: manifest.project.name } : null,
      },
    });
  }

  return {
    local_path: workspacePath,
    project: manifest?.project.name ?? null,
    git: gitState as unknown as Record<string, unknown>,
    readiness: readiness as unknown as Record<string, unknown>,
  };
});
