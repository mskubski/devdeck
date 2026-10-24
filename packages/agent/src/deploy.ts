import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '@devdeck/shared';
import { gitStatus } from './git.js';
import { fastForwardToTarget, rollbackMove, type GitMove } from './updateGit.js';
import { loadManifest, type DeployConfig } from './manifest.js';

const exec = promisify(execFile);

export interface DeployStep {
  step: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

export interface CmdResult {
  code: number;
  output: string;
}

/** Austauschbare Außenwelt (systemctl, Installationsbefehl, HTTP) – in Tests ersetzt. */
export interface DeployDeps {
  systemctl(args: string[]): Promise<CmdResult>;
  run(cwd: string, command: string): Promise<CmdResult>;
  httpOk(url: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export const realDeps: DeployDeps = {
  async systemctl(args) {
    return runCmd('systemctl', ['--user', ...args], process.cwd());
  },
  async run(cwd, command) {
    const [cmd, ...args] = command.split(/\s+/);
    return runCmd(cmd!, args, cwd, 15 * 60_000);
  },
  async httpOk(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return res.ok;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function runCmd(cmd: string, args: string[], cwd: string, timeout = 60_000): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, output: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`.trim() };
  }
}

const tail = (s: string, n = 300): string => s.trim().split('\n').slice(-4).join(' | ').slice(-n);

export interface DeployOutcome {
  steps: DeployStep[];
  from: string;
  to: string;
  up_to_date: boolean;
  services: string[];
}

/** Wartet, bis ein Dienst gesund ist (HTTP 2xx bzw. `is-active`); false nach Ablauf des Zeitlimits. */
async function waitHealthy(
  unit: { unit: string; health_url?: string },
  timeoutSeconds: number,
  deps: DeployDeps,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = '';
  for (;;) {
    if (unit.health_url) {
      if (await deps.httpOk(unit.health_url)) return { ok: true, detail: unit.health_url };
      last = `${unit.health_url} antwortet nicht mit 2xx`;
    } else {
      const r = await deps.systemctl(['is-active', unit.unit]);
      if (r.code === 0 && r.output.trim().split('\n').pop() === 'active') return { ok: true, detail: 'aktiv' };
      last = `Status „${r.output.trim().split('\n').pop() || 'unbekannt'}“`;
    }
    if (Date.now() >= deadline) return { ok: false, detail: last };
    await deps.sleep(2_000);
  }
}

/**
 * Deploy eines Workspaces: sauberer Baum → Fast-Forward auf den Ziel-Branch → Manifest (`deploy`) →
 * optional Install → systemd-Benutzerdienste neu starten → Gesundheitsprüfung. Scheitert irgendein Schritt nach
 * dem Code-Wechsel, geht es auf den alten Commit zurück und die Dienste werden damit neu gestartet.
 */
export async function runDeploy(
  root: string,
  branchHint: string | null,
  deps: DeployDeps = realDeps,
): Promise<DeployOutcome> {
  const steps: DeployStep[] = [];
  const fail = (message: string): never => {
    const summary = steps.map((s) => `${s.step}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`).join(' → ');
    throw new AppError('INTERNAL', `${message}${summary ? ` [${summary}]` : ''}`);
  };

  const state = await gitStatus(root);
  if (state.dirty) {
    throw new AppError('GIT_DIRTY', `STOP: ${state.files.length} lokale, nicht committete Änderung(en) – Deploy abgebrochen, nichts verändert.`, {
      files: state.files.slice(0, 20),
    });
  }
  steps.push({ step: 'Arbeitskopie sauber', status: 'ok' });

  const target = branchHint && branchHint !== 'HEAD' ? branchHint : state.branch && state.branch !== 'HEAD' ? state.branch : 'main';
  const move: GitMove = await fastForwardToTarget(root, target);
  steps.push({
    step: 'Code holen',
    status: 'ok',
    detail: move.before === move.after ? `${target} @ ${move.after} (unverändert)` : `${target}: ${move.before} → ${move.after}`,
  });

  let restarted = false;
  let config: DeployConfig | undefined;
  const rollback = async (): Promise<string> => {
    try {
      await rollbackMove(root, move);
      let note = `Stand ${move.before} wiederhergestellt`;
      if (config && restarted && move.before !== move.after) {
        if (config.install) await deps.run(root, config.install);
        for (const s of config.services) await deps.systemctl(['restart', s.unit]);
        note += ', Dienste mit dem alten Stand neu gestartet';
      }
      return note;
    } catch (e) {
      return `Rücknahme fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  try {
    config = loadManifest(root)?.deploy;
  } catch (err) {
    steps.push({ step: 'Manifest lesen', status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    const note = await rollback();
    return fail(`Deploy-Konfiguration ungültig – ${note}`);
  }
  if (!config) {
    steps.push({ step: 'Manifest lesen', status: 'failed', detail: 'kein deploy-Block in .devdeck/workspace.yaml' });
    const note = await rollback();
    return fail(`Kein deploy-Block in .devdeck/workspace.yaml – ${note}`);
  }
  steps.push({ step: 'Manifest lesen', status: 'ok', detail: `${config.services.length} Dienst(e)` });

  if (config.install) {
    if (move.before === move.after) {
      steps.push({ step: 'Installation', status: 'skipped', detail: 'kein neuer Code' });
    } else {
      const r = await deps.run(root, config.install);
      if (r.code !== 0) {
        steps.push({ step: 'Installation', status: 'failed', detail: tail(r.output) });
        const note = await rollback();
        return fail(`Installation fehlgeschlagen – ${note}`);
      }
      steps.push({ step: 'Installation', status: 'ok', detail: config.install });
    }
  }

  restarted = true;
  for (const s of config.services) {
    const r = await deps.systemctl(['restart', s.unit]);
    if (r.code !== 0) {
      steps.push({ step: `Neustart ${s.unit}`, status: 'failed', detail: tail(r.output) });
      const note = await rollback();
      return fail(`Neustart von ${s.unit} fehlgeschlagen – ${note}`);
    }
    steps.push({ step: `Neustart ${s.unit}`, status: 'ok' });
  }
  for (const s of config.services) {
    const h = await waitHealthy(s, config.timeout_seconds, deps);
    steps.push({ step: `Prüfung ${s.unit}`, status: h.ok ? 'ok' : 'failed', detail: h.detail });
    if (!h.ok) {
      const note = await rollback();
      return fail(`${s.unit} ist nach dem Neustart nicht gesund – ${note}`);
    }
  }

  return {
    steps,
    from: move.before,
    to: move.after,
    up_to_date: move.before === move.after,
    services: config.services.map((s) => s.unit),
  };
}
