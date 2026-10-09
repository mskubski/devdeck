import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { loadManifest } from '../manifest.js';
import { gitStatus, isGitRepo, pullFFOnly } from '../git.js';
import { buildReadiness } from '../readiness.js';
import { installDependencies, lockfileHash } from '../dependencies.js';

/**
 * workspace.sync – SICHERER Workspace-Sync (Spezifikation §10):
 * Git-Status → bei local changes STOP → fetch + pull --ff-only →
 * Dependency-Check → Secret-Checks → Context-Refresh → Readiness.
 * Nie reset/stash/clean – nicht committete Änderungen werden nie überschrieben.
 */
registerAction('workspace.sync', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const manifest = loadManifest(workspacePath);
  const workspaceId =
    typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;

  // 1) Git-Status prüfen
  const repo = await isGitRepo(workspacePath);
  if (!repo) {
    throw new AppError('GIT_UNREACHABLE', 'Workspace ist kein Git-Repository – Sync gestoppt');
  }
  const gitState = await gitStatus(workspacePath);
  if (gitState.dirty) {
    throw new AppError(
      'GIT_DIRTY',
      `STOP: ${gitState.files.length} lokale, nicht committete Änderung(en). ` +
        'Es wurde nichts verändert – bitte committen oder stashen und erneut syncen.',
      { files: gitState.files.slice(0, 50) },
    );
  }

  // 2) Sicheres Git-Update (nur Fast-Forward)
  await pullFFOnly(workspacePath);
  const afterSync = await gitStatus(workspacePath);

  // 3) Dependency-Check: Lockfile-Hash gegen letzten Installationsstand
  const statePath = path.join(workspacePath, '.devdeck', 'state.json');
  let previousHash: string | null = null;
  try {
    if (fs.existsSync(statePath)) {
      previousHash =
        (JSON.parse(fs.readFileSync(statePath, 'utf8')) as { lockfile_hash?: string })
          .lockfile_hash ?? null;
    }
  } catch {
    previousHash = null;
  }
  const currentHash = await lockfileHash(workspacePath);
  let dependencyAction: 'none' | 'install' | 'skipped' = 'none';
  if (manifest?.package_manager && currentHash && currentHash !== previousHash) {
    await installDependencies(workspacePath, manifest);
    dependencyAction = 'install';
  }

  // 4+5) Secret-/Context-Checks – Endpunkte werden in Phasen G/F genutzt;
  // solange sie fehlen, werden die Schritte übersprungen (degradiert kontrolliert).
  const secretsCheck = await ctx.client.request('POST', '/api/agent/secrets/check', {
    body: { workspace_id: workspaceId, local_path: workspacePath },
  });
  const secretState =
    secretsCheck.status === 200 ? (secretsCheck.data as Record<string, unknown>) : null;
  const contextRefresh = await ctx.client.request('POST', '/api/agent/context/write', {
    body: { workspace_id: workspaceId, local_path: workspacePath },
  });
  const contextState =
    contextRefresh.status === 200 ? (contextRefresh.data as Record<string, unknown>) : null;

  // 6) Readiness bewerten und melden
  const readiness = await buildReadiness({
    workspacePath,
    manifest,
    gitState: afterSync,
    isRepo: true,
    gitAvailable: true,
  });
  if (workspaceId) {
    await ctx.client.request('POST', `/api/agent/workspaces/${workspaceId}/status`, {
      body: { git: afterSync, readiness },
    });
  }
  if (currentHash) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ lockfile_hash: currentHash }), 'utf8');
  }

  return {
    local_path: workspacePath,
    git: afterSync as unknown as Record<string, unknown>,
    dependency_action: dependencyAction,
    secrets: secretState,
    context: contextState,
    readiness: readiness as unknown as Record<string, unknown>,
  };
});
