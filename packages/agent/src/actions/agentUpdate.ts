import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { git, gitStatus } from '../git.js';
import { fastForwardToTarget, rollbackMove, updateBranch } from '../updateGit.js';
import { log } from '../logger.js';
import { planUpdate } from '../updatePlan.js';
import { AGENT_VERSION } from '../config.js';
import { getRunningHead, setRunningHead } from '../runtimeInfo.js';

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

/**
 * Prüft den frisch gebauten Code, bevor der laufende Agent ersetzt wird: `index.js status` muss starten und die
 * erwartete Version melden. So bricht ein defektes Update VOR dem Neustart ab (der alte Agent läuft weiter) und
 * die Fehlermeldung nennt Node-Version und Ausgabe.
 */
async function smokeTest(root: string): Promise<{ version: string; node: string }> {
  const entry = path.join(root, 'packages', 'agent', 'dist', 'index.js');
  try {
    const { stdout } = await exec(process.execPath, [entry, 'status'], { cwd: root, timeout: 30_000, windowsHide: true });
    const info = JSON.parse(stdout) as { agent_version?: string; node?: string };
    if (!info.agent_version) throw new Error('Status-Ausgabe ohne agent_version');
    return { version: info.agent_version, node: info.node ?? process.version };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new AppError(
      'INTERNAL',
      `Der neu gebaute Agent startet nicht (Node ${process.version}, ${entry}): ${(e.stderr || e.message || 'unbekannter Fehler').trim().split('\n').slice(-4).join(' | ').slice(0, 400)} – ` +
        'Update abgebrochen, der bisherige Agent läuft weiter.',
    );
  }
}

/** Beim Agent-Start aufrufen: merkt sich den Commit, aus dem der laufende Code stammt. */
export async function recordRunningHead(): Promise<void> {
  try {
    const r = await git(repoRoot(), ['rev-parse', '--short', 'HEAD']);
    if (r.code === 0) setRunningHead(r.stdout.trim());
  } catch {
    setRunningHead(null);
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
  let state = await gitStatus(root);
  // package-lock.json wird von npm gelegentlich umgeschrieben und ist nie von Hand geändert → zurücksetzen statt blockieren
  if (state.dirty && state.files.every((f) => f.trim() === 'package-lock.json')) {
    await git(root, ['checkout', '--', 'package-lock.json']);
    state = await gitStatus(root);
  }
  if (state.dirty) {
    throw new AppError(
      'GIT_DIRTY',
      `Agent-Installation (${root}) hat lokale Änderungen – Update gestoppt.`,
      { files: state.files.slice(0, 20) },
    );
  }
  const move = await fastForwardToTarget(root);
  const { before, after } = move;
  if (move.switched) log.info(`Branch gewechselt: ${move.beforeBranch} -> ${updateBranch()}`);
  const plan = planUpdate(before, after, getRunningHead());
  const undo = async (): Promise<void> => {
    // Defektes Update nicht auf der Platte stehen lassen: zurück auf den alten Stand und neu bauen (best effort)
    try {
      await rollbackMove(root, move);
      await npm(root, ['ci', '--no-audit', '--no-fund']).catch(() => npm(root, ['install', '--no-audit', '--no-fund']));
      await npm(root, ['run', 'build']);
      log.info(`Update zurückgenommen: wieder auf ${move.before}`);
    } catch (e) {
      log.error(`Rücknahme fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  try {
    // `npm ci` statt `npm install`: verändert die package-lock.json nicht (sonst gilt der Ordner als „geändert“)
    if (plan.install) {
      try {
        await npm(root, ['ci', '--no-audit', '--no-fund']);
      } catch {
        // `npm ci` löscht node_modules zuerst; bei einem Fehler (z. B. Dateisperre unter Windows) reparieren
        await npm(root, ['install', '--no-audit', '--no-fund']);
      }
    }
    if (plan.build) await npm(root, ['run', 'build']);
  } catch (err) {
    await undo();
    throw new AppError(
      'INTERNAL',
      `Build fehlgeschlagen, Stand ${move.before} wiederhergestellt (Agent läuft unverändert weiter): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!plan.restart) {
    log.info(`Agent ist bereits auf dem neuesten Stand (${after})`);
    return { from: before, to: after, restarting: false, up_to_date: true };
  }
  log.info(`Update ${before} -> ${after}: Build fertig, prüfe neuen Code …`);
  const fresh = await smokeTest(root).catch(async (err) => {
    await undo();
    throw err;
  });
  const mode = process.env.INVOCATION_ID ? 'systemd (Exit-Code 75)' : 'Neustart als neuer Prozess';
  log.info(`Update ${before} -> ${after} abgeschlossen: neue Version ${fresh.version}, Node ${process.version}, Neustart: ${mode}`);
  scheduleRestart();
  return {
    from: before, to: after, restarting: true,
    new_version: fresh.version, running_version: AGENT_VERSION, node: process.version,
    entry: process.argv[1] ?? '', restart_mode: mode,
  };
});
