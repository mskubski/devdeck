import { AppError } from '@devdeck/shared';
import { git } from './git.js';

/** Branch, auf den Agent-Updates aktualisieren (wie beim Server-Update; per Umgebungsvariable änderbar). */
export function updateBranch(): string {
  return process.env.DEVDECK_UPDATE_BRANCH || 'main';
}

export interface GitMove {
  beforeBranch: string;
  beforeHash: string;
  before: string;
  after: string;
  switched: boolean;
}

/**
 * Holt `origin/<target>` und führt den Checkout per Fast-Forward darauf. Steht der Ordner auf einem anderen Branch
 * (z. B. einem längst gemergten Feature-Branch, dessen Remote gelöscht wurde), wird auf `<target>` gewechselt –
 * statt an „no such ref was fetched“ zu scheitern. Vorausgesetzt: der Baum ist sauber (vom Aufrufer geprüft).
 * Nie reset/stash; ein Update, das nicht per Fast-Forward möglich ist, bricht ab.
 */
export async function fastForwardToTarget(root: string, target = updateBranch()): Promise<GitMove> {
  const beforeBranch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const beforeHash = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const before = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();

  const fetch = await git(root, ['fetch', 'origin', target], 5 * 60_000);
  if (fetch.code !== 0) {
    throw new AppError('GIT_UNREACHABLE', `git fetch origin ${target} fehlgeschlagen: ${fetch.stderr.trim().slice(0, 300)}`);
  }
  let switched = false;
  if (beforeBranch !== target) {
    const co = await git(root, ['checkout', target]);
    if (co.code !== 0) {
      throw new AppError('GIT_CONFLICT', `Wechsel von „${beforeBranch}“ auf „${target}“ fehlgeschlagen: ${co.stderr.trim().slice(0, 300)}`);
    }
    switched = true;
  }
  const merge = await git(root, ['merge', '--ff-only', `origin/${target}`], 5 * 60_000);
  if (merge.code !== 0) {
    // Beim Branch-Wechsel zurück, damit nichts halb umgestellt bleibt
    if (switched) await git(root, ['checkout', beforeBranch === 'HEAD' ? beforeHash : beforeBranch]);
    throw new AppError('GIT_CONFLICT', `Kein Fast-Forward auf origin/${target} möglich: ${merge.stderr.trim().slice(0, 300)}`);
  }
  const after = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  return { beforeBranch, beforeHash, before, after, switched };
}

/** Nach einem Fehlschlag zurück auf den vorherigen Stand (Baum war vorher sauber). */
export async function rollbackMove(root: string, move: GitMove): Promise<void> {
  if (move.beforeBranch && move.beforeBranch !== 'HEAD') await git(root, ['checkout', '-f', move.beforeBranch]);
  await git(root, ['reset', '--hard', move.beforeHash]);
}
