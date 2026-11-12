import { AppError } from '@devdeck/shared';
import { getAction, registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { gitStatus, isGitRepo, pushCurrentBranch } from '../git.js';
import { log } from '../logger.js';

/**
 * workspace.push – pusht die lokalen Commits des aktuellen Branches nach GitHub (normaler Push: nie Force, nie reset/stash).
 * Zugangsdaten fragt Git nie interaktiv ab; fehlen sie auf der Maschine (Deploy-Key/Token), gibt es eine klare Meldung.
 */
registerAction('workspace.push', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  if (!(await isGitRepo(workspacePath))) throw new AppError('GIT_UNREACHABLE', 'Workspace ist kein Git-Repository – Push gestoppt');
  const before = await gitStatus(workspacePath);
  if (!before.branch || before.branch === 'HEAD') {
    throw new AppError('VALIDATION', 'Kein Branch ausgecheckt (losgelöster HEAD) – Push gestoppt');
  }
  const pushed = before.ahead;
  await pushCurrentBranch(workspacePath);
  log.info(`Push: ${pushed} Commit(s) von ${before.branch} nach origin`);
  // frischen Stand an den Server melden (ahead/behind, Readiness)
  const status = getAction('workspace.status');
  const state = status ? await status(ctx) : null;
  return { local_path: workspacePath, branch: before.branch, pushed, git: (state as { git?: unknown } | null)?.git ?? null } as unknown as Record<string, unknown>;
});
