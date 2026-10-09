import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { AppError, type GitState } from '@devdeck/shared';

const exec = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Git ohne Shell ausführen (keine Interpreter-Injection). */
export async function git(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof e.code === 'number') {
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
    }
    throw err;
  }
}

/** Strukturierten Fehler aus einem fehlgeschlagenen Git-Lauf ableiten. */
export function gitError(result: GitResult, operation: string): AppError {
  const err = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    err.includes('could not resolve host') ||
    err.includes('unable to access') ||
    err.includes('connection refused') ||
    err.includes('network is unreachable') ||
    err.includes('repository not found')
  ) {
    return new AppError('GIT_UNREACHABLE', `Git-Remote nicht erreichbar bei ${operation}`);
  }
  if (err.includes('conflict') || err.includes('merge conflict')) {
    return new AppError('GIT_CONFLICT', `Git-Konflikt bei ${operation}`);
  }
  if (err.includes('not possible to fast-forward') || err.includes('divergent branches')) {
    return new AppError('GIT_CONFLICT', `Kein Fast-Forward möglich bei ${operation} – manuelle Lösung nötig`);
  }
  if (err.includes('not a git repository')) {
    return new AppError('GIT_UNREACHABLE', 'Verzeichnis ist kein Git-Repository');
  }
  return new AppError('GIT_UNREACHABLE', `Git-Fehler bei ${operation}: ${result.stderr.trim().slice(0, 300)}`);
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await git(cwd, ['rev-parse', '--is-inside-work-tree'], 10_000);
  return res.code === 0 && res.stdout.trim() === 'true';
}

/**
 * Vollständigen Git-Zustand erfassen.
 * `dirty` = es gibt lokale Änderungen – der Sync darf dann NIEMALS überschreiben.
 */
export async function gitStatus(cwd: string): Promise<GitState> {
  const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
  const commitRes = await git(cwd, ['rev-parse', 'HEAD']);
  const commit = commitRes.code === 0 ? commitRes.stdout.trim() : null;
  const porcelain = await git(cwd, ['status', '--porcelain']);
  const files =
    porcelain.code === 0
      ? porcelain.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3))
      : [];
  let ahead = 0;
  let behind = 0;
  if (branch && branch !== 'HEAD') {
    const count = await git(cwd, ['rev-list', '--left-right', '--count', `@{u}...HEAD`]);
    if (count.code === 0) {
      const [b, a] = count.stdout.trim().split(/\s+/);
      behind = Number(b ?? 0) || 0;
      ahead = Number(a ?? 0) || 0;
    }
  }
  const authorRes = await git(cwd, ['log', '-1', '--format=%an|%aI|%s']);
  const state: GitState = { branch, commit, dirty: files.length > 0, ahead, behind, files: files.slice(0, 200) };
  if (authorRes.code === 0) {
    const parts = authorRes.stdout.trim().split('|');
    state.author = parts[0] ?? null;
    state.committed_at = parts[1] ?? null;
    state.message = parts.slice(2).join('|') || null;
  }
  return state;
}

export async function clone(url: string, targetDir: string, branch?: string | null): Promise<void> {
  // Optionen müssen VOR `--` stehen, sonst interpretiert Git sie als Pfade.
  const args = branch
    ? ['clone', '--branch', branch, '--', url, targetDir]
    : ['clone', '--', url, targetDir];
  const res = await git(process.cwd(), args, 10 * 60_000);
  if (res.code !== 0) throw gitError(res, 'clone');

  // Robustheit 1: Bare-Remotes ohne HEAD (leere, später befüllte Repos) liefern
  // einen Klon ohne ausgecheckte Dateien – dann explizit initialisieren.
  if (!(await isGitRepo(targetDir)) && branch) {
    fs.mkdirSync(targetDir, { recursive: true });
    const init = await git(targetDir, ['init', '-b', branch], 30_000);
    if (init.code !== 0) throw gitError(init, 'init (leeres Remote)');
    const add = await git(targetDir, ['remote', 'add', 'origin', url], 30_000);
    if (add.code !== 0) throw gitError(add, 'remote add (leeres Remote)');
    const fetchRes = await git(targetDir, ['fetch', 'origin'], 60_000);
    if (fetchRes.code !== 0) throw gitError(fetchRes, 'fetch (leeres Remote)');
    const checkout = await git(targetDir, ['checkout', branch, '--'], 60_000);
    if (checkout.code !== 0) throw gitError(checkout, 'checkout (leeres Remote)');
    return;
  }

  // Robustheit 2: Remote-HEAD zeigt ins Leere (der Klon hängt dann an einem
  // nicht existenten lokalen Branch, z. B. master statt main). Falls der lokale
  // HEAD kein Branch ist, gewünschten (oder ersten verfügbaren) Remote-Branch
  // auschecken.
  const head = await git(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headName = head.code === 0 ? head.stdout.trim() : null;
  if (head.code !== 0 || headName === 'HEAD') {
    const branches = await git(targetDir, ['branch', '-r', '--format=%(refname:short)']);
    const remoteBranches = branches.code === 0 ? branches.stdout.split('\n').filter(Boolean) : [];
    const wanted = branch ? `origin/${branch}` : (remoteBranches.find((b) => b === 'origin/main') ?? remoteBranches[0]);
    if (wanted && remoteBranches.includes(wanted)) {
      const localName = wanted.replace(/^origin\//, '');
      const checkout = await git(targetDir, ['checkout', '-B', localName, '--track', wanted, '--'], 60_000);
      if (checkout.code !== 0) throw gitError(checkout, 'checkout (Remote-HEAD)');
    }
  }
}

/** Nur Fast-Forward – niemals reset/stash/clean (Spezifikation §10). */
export async function pullFFOnly(cwd: string): Promise<{ updated: boolean }> {
  // Ohne Tracking-Branch gibt es nichts zu holen – kein Fehler.
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']);
  if (upstream.code !== 0) return { updated: false };

  const fetchRes = await git(cwd, ['fetch', '--all', '--prune']);
  if (fetchRes.code !== 0) throw gitError(fetchRes, 'fetch');
  const pullRes = await git(cwd, ['pull', '--ff-only']);
  if (pullRes.code === 0) return { updated: true };
  throw gitError(pullRes, 'pull --ff-only');
}
