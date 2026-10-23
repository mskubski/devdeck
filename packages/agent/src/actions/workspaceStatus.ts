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
      `Pfad ${resolved} liegt außerhalb des Workspace-Root (${root}) – Aktion abgelehnt. ` +
        'Workspace-Root des Agenten anpassen: "devdeck-agent start --workspace-root <Pfad>" ' +
        '(oder "workspaceRoot" in der Agent-Konfiguration / DEVDECK_WORKSPACE_ROOT) und Agent neu starten.',
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new AppError('NOT_FOUND', `Workspace-Verzeichnis existiert nicht: ${resolved}`);
  }
  return resolved;
}

registerAction('workspace.status', async (ctx) => {
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  } catch (err) {
    // Ein fehlender/unzulässiger Pfad ist selbst ein Prüfergebnis: melden, statt nur zu scheitern
    // (sonst bliebe der Workspace in der UI ewig „unknown“ ohne Erklärung).
    const workspaceId = typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;
    const code = (err as { code?: string }).code;
    if (workspaceId && (code === 'NOT_FOUND' || code === 'FORBIDDEN')) {
      const detail =
        code === 'NOT_FOUND'
          ? 'Ordner existiert noch nicht – „Provision“ ausführen (klont das Repository dorthin)'
          : err instanceof Error
            ? err.message
            : 'Pfad nicht zulässig';
      const readiness = { overall: 'BLOCKED' as const, checks: [{ name: 'Verzeichnis', status: 'BLOCKED' as const, detail }] };
      await ctx.client.request('POST', `/api/agent/workspaces/${workspaceId}/status`, {
        body: { git: null, readiness },
      });
      return { local_path: String(ctx.payload.local_path), project: null, git: null, readiness } as unknown as Record<string, unknown>;
    }
    throw err;
  }
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
