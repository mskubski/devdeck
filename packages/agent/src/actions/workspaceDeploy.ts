import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { runDeploy } from '../deploy.js';
import { loadManifest } from '../manifest.js';
import { fetchRemote, gitStatus } from '../git.js';
import { buildReadiness } from '../readiness.js';
import { collectFacts } from '../facts.js';

/**
 * workspace.deploy – bringt den Workspace auf den Stand des Ziel-Branches und startet die im Manifest
 * (`.devdeck/workspace.yaml`, Block `deploy`) benannten systemd-Benutzerdienste neu. Keine freien Befehle von außen:
 * Dienste und optionaler Install-Befehl stammen aus dem versionierten Repository. Bei Fehlern Rücknahme.
 */
registerAction('workspace.deploy', async (ctx) => {
  if (process.platform !== 'linux') {
    throw new AppError('VALIDATION', 'Deploy wird nur auf Linux-Maschinen (systemd --user) unterstützt');
  }
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const workspaceId = typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;
  const branch = typeof ctx.payload.branch === 'string' && /^[\w./-]{1,200}$/.test(ctx.payload.branch) && !ctx.payload.branch.startsWith('-')
    ? ctx.payload.branch
    : null;

  const outcome = await runDeploy(workspacePath, branch);

  // Neuen Stand melden (wie nach einem Sync), damit Status und Commit in der Oberfläche stimmen
  if (workspaceId) {
    const remoteReachable = await fetchRemote(workspacePath);
    const gitState = await gitStatus(workspacePath);
    const readiness = await buildReadiness({
      workspacePath,
      manifest: loadManifest(workspacePath),
      gitState,
      isRepo: true,
      gitAvailable: true,
      remoteReachable,
    });
    await ctx.client.request('POST', `/api/agent/workspaces/${workspaceId}/status`, {
      body: { git: gitState, readiness, facts: collectFacts(workspacePath) },
    });
  }
  return { local_path: workspacePath, ...outcome } as unknown as Record<string, unknown>;
});
