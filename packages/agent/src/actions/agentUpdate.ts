import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { git, gitStatus } from '../git.js';
import { log } from '../logger.js';
import { planUpdate } from '../updatePlan.js';

const exec = promisify(execFile);

/** Repo-Root der laufenden Agent-Installation (packages/agent/dist/actions → Repo). */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function npm(cwd: string, args: string[]): Promise<void> {
  // Feste Argumente, keine Nutzereingaben; unter Windows ist npm eine .cmd-Datei.
  await exec('npm', args, {
    cwd,
    timeout: 10 * 60_000,
    windowsHide: true,
    shell: process.platform === 'win32',
    maxBuffer: 20 * 1024 * 1024,
  });
}

let runningHead: string | null = null;

/** Beim Agent-Start aufrufen: merkt sich den Commit, aus dem der laufende Code stammt. */
export async function recordRunningHead(): Promise<void> {
  try {
    const r = await git(repoRoot(), ['rev-parse', '--short', 'HEAD']);
    if (r.code === 0) runningHead = r.stdout.trim();
  } catch {
    runningHead = null;
  }
}

/** Nach dem Ergebnis-Report neu starten (systemd startet bei Exit-Code ≠ 0, sonst Selbst-Respawn). */
function scheduleRestart(): void {
  setTimeout(() => {
    log.info('Neustart nach Update …');
    if (process.env.INVOCATION_ID) {
      process.exit(75);
    }
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DEVDECK_START_DELAY_MS: '3000' },
    });
    child.unref();
    process.exit(0);
  }, 1500).unref?.();
}

/**
 * agent.update – aktualisiert die Agent-Installation: nur Fast-Forward-Pull
 * (nie reset/stash), npm install, Build, danach Neustart.
 */
registerAction('agent.update', async () => {
  const root = repoRoot();
  const state = await gitStatus(root);
  if (state.dirty) {
    throw new AppError(
      'GIT_DIRTY',
      `Agent-Installation (${root}) hat lokale Änderungen – Update gestoppt.`,
      { files: state.files.slice(0, 20) },
    );
  }
  const before = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const pull = await git(root, ['pull', '--ff-only'], 5 * 60_000);
  if (pull.code !== 0) {
    throw new AppError('GIT_UNREACHABLE', `git pull fehlgeschlagen: ${pull.stderr.trim()}`);
  }
  const after = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const plan = planUpdate(before, after, runningHead);
  try {
    // `npm ci` statt `npm install`: verändert die package-lock.json nicht (sonst gilt der Ordner als „geändert“)
    if (plan.install) await npm(root, ['ci', '--no-audit', '--no-fund']);
    if (plan.build) await npm(root, ['run', 'build']);
  } catch (err) {
    throw new AppError(
      'INTERNAL',
      `Build fehlgeschlagen (Agent läuft unverändert weiter): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!plan.restart) {
    log.info(`Agent ist bereits auf dem neuesten Stand (${after})`);
    return { from: before, to: after, restarting: false, up_to_date: true };
  }
  log.info(`Update ${before} -> ${after} abgeschlossen`);
  scheduleRestart();
  return { from: before, to: after, restarting: true };
});
