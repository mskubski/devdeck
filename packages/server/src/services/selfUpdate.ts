import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, supportsSelfUpdate } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { audit } from './audit.js';
import { createSystemBackup } from './backups.js';
import { enqueueCommand } from './provisioning.js';
import { setSetting } from './settings.js';

const exec = promisify(execFile);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Feste Befehle ohne Nutzereingaben; Git darf nie nach Zugangsdaten fragen (würde hängen). */
async function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

const git = (root: string, args: string[], timeoutMs?: number) => run('git', args, root, timeoutMs);

export interface VersionInfo {
  commit: string;
  subject: string;
  branch: string;
  target_branch: string;
  dirty: boolean;
  /** Commits auf dem Remote-Zielbranch, die noch fehlen (nur nach fetch). */
  behind: number | null;
  on_other_branch: boolean;
  fetch_error: string | null;
  can_restart: boolean;
}

export async function getVersionInfo(ctx: AppContext, fetchRemote: boolean): Promise<VersionInfo> {
  const root = ctx.config.repoRoot;
  const target = ctx.config.updateBranch;
  const head = await git(root, ['rev-parse', '--short', 'HEAD']);
  if (head.code !== 0) throw new AppError('GIT_UNREACHABLE', 'Server läuft nicht aus einem Git-Checkout – Update nicht möglich');
  const subject = (await git(root, ['log', '-1', '--format=%s'])).stdout.trim();
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim().length > 0;
  let fetchError: string | null = null;
  if (fetchRemote) {
    const f = await git(root, ['fetch', 'origin', target], 30_000);
    if (f.code !== 0) fetchError = 'GitHub nicht erreichbar oder Zugriff verweigert';
  }
  const behind = await git(root, ['rev-list', '--count', `HEAD..origin/${target}`]);
  return {
    commit: head.stdout.trim(),
    subject,
    branch,
    target_branch: target,
    dirty,
    behind: behind.code === 0 ? Number(behind.stdout.trim()) : null,
    on_other_branch: branch !== target,
    fetch_error: fetchError,
    can_restart: Boolean(ctx.restart) || Boolean(process.env.INVOCATION_ID),
  };
}

export interface UpdateStep {
  name: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
}

export interface UpdateState {
  state: 'idle' | 'running' | 'success' | 'failed';
  started_at: string | null;
  finished_at: string | null;
  steps: UpdateStep[];
  from: string | null;
  to: string | null;
  error: string | null;
  restarting: boolean;
}

const state: UpdateState = {
  state: 'idle', started_at: null, finished_at: null, steps: [], from: null, to: null, error: null, restarting: false,
};

export function getUpdateState(): UpdateState {
  return { ...state, steps: state.steps.map((s) => ({ ...s })) };
}

function defaultRestart(): void {
  // systemd startet den Server bei Exit-Code ≠ 0 neu (Restart=on-failure)
  setTimeout(() => process.exit(75), 1500).unref?.();
}

export interface UpdateActor {
  id: string | null;
  label: string;
  type: 'user' | 'system';
}

export interface UpdateOptions {
  /** Nach dem Server-Update auch alle online befindlichen Agents aktualisieren lassen. */
  agents: boolean;
}

/** Startet das Update im Hintergrund; es läuft höchstens eines gleichzeitig. */
export function startSelfUpdate(ctx: AppContext, actor: UpdateActor, options: UpdateOptions = { agents: false }): void {
  if (state.state === 'running') throw new AppError('CONFLICT', 'Es läuft bereits ein Update');
  Object.assign(state, {
    state: 'running', started_at: new Date().toISOString(), finished_at: null, steps: [],
    from: null, to: null, error: null, restarting: false,
  } satisfies UpdateState);
  audit(ctx.db, {
    actor_type: actor.type, actor_id: actor.id, actor_label: actor.label,
    action: 'system.update.start', target_type: 'system', result: 'success',
    detail: { agents: options.agents },
  });
  void performUpdate(ctx, actor, options);
}

/** Merkt das Ergebnis für die System-Seite (überlebt den Neustart). */
function recordResult(ctx: AppContext, actor: UpdateActor, result: 'success' | 'failed', detail: string): void {
  setSetting(ctx.db, 'last_update', JSON.stringify({
    at: new Date().toISOString(),
    by: actor.type === 'system' ? 'automatisch' : actor.label,
    result,
    detail,
  }));
}

/** agent.update für alle online befindlichen Agents einreihen (sie holen es nach dem Server-Neustart ab). */
function queueAgentUpdates(ctx: AppContext, actor: UpdateActor): string {
  const machines = ctx.db.all<{ id: string; name: string; agent_version: string | null }>(
    `SELECT id, name, agent_version FROM machines WHERE revoked_at IS NULL AND agent_status = 'online'`,
  );
  let queued = 0;
  const skipped: string[] = [];
  for (const m of machines) {
    if (!supportsSelfUpdate(m.agent_version)) {
      skipped.push(m.name);
      continue;
    }
    enqueueCommand(ctx.db, { machineId: m.id, action: 'agent.update', payload: {}, requestedBy: actor.id, ttlSeconds: 900 });
    queued++;
  }
  audit(ctx.db, {
    actor_type: actor.type, actor_id: actor.id, actor_label: actor.label,
    action: 'system.update.agents', target_type: 'system', result: 'success',
    detail: { queued, skipped },
  });
  return skipped.length
    ? `${queued} beauftragt, ${skipped.length} zu alt für Selbst-Update (${skipped.join(', ')}) – manuell aktualisieren`
    : `${queued} beauftragt`;
}

async function performUpdate(ctx: AppContext, actor: UpdateActor, options: UpdateOptions): Promise<void> {
  const root = ctx.config.repoRoot;
  const target = ctx.config.updateBranch;
  const step = async <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string | undefined): Promise<T> => {
    const s: UpdateStep = { name, status: 'running' };
    state.steps.push(s);
    try {
      const r = await fn();
      s.status = 'done';
      s.detail = detail?.(r);
      return r;
    } catch (err) {
      s.status = 'failed';
      s.detail = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };
  const must = (r: RunResult, what: string): RunResult => {
    if (r.code !== 0) throw new AppError('INTERNAL', `${what} fehlgeschlagen: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
    return r;
  };

  let beforeHash = '';
  let beforeBranch = '';
  let changed = false;
  try {
    const info = await step('Zustand prüfen', () => getVersionInfo(ctx, false), (i) => `${i.branch} @ ${i.commit}`);
    if (info.dirty) {
      throw new AppError('GIT_DIRTY', 'Der Server-Ordner hat lokale Änderungen an versionierten Dateien – Update gestoppt (nicht im Server-Ordner entwickeln).');
    }
    beforeBranch = info.branch;
    beforeHash = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    state.from = info.commit;

    await step('Von GitHub laden', async () => must(await git(root, ['fetch', 'origin', target], 60_000), 'git fetch'));
    const remoteHash = (await git(root, ['rev-parse', `origin/${target}`])).stdout.trim();
    // Code auf der Platte kann neuer sein als der laufende Prozess (z. B. von Hand gepullt): dann trotzdem bauen + neu starten
    const diskNewerThanProcess = Boolean(ctx.runningCommit) && ctx.runningCommit !== beforeHash;
    if (remoteHash === beforeHash && beforeBranch === target && !diskNewerThanProcess) {
      state.to = info.commit;
      state.steps.push({ name: 'Server bereits auf dem neuesten Stand', status: 'done' });
      if (options.agents) {
        await step('Agents aktualisieren', async () => queueAgentUpdates(ctx, actor), (r) => r);
      }
      state.state = 'success';
      state.finished_at = new Date().toISOString();
      recordResult(ctx, actor, 'success', 'bereits aktuell');
      return;
    }

    await step('Datensicherung', async () => {
      const b = createSystemBackup(ctx, actor);
      if (b.status !== 'success') throw new AppError('INTERNAL', `Backup fehlgeschlagen: ${b.error ?? 'unbekannt'} – Update abgebrochen`);
      return b;
    });

    changed = true;
    if (beforeBranch !== target) {
      await step(`Auf ${target} wechseln`, async () => must(await git(root, ['checkout', target]), 'git checkout'));
    }
    await step('Code aktualisieren', async () => must(await git(root, ['merge', '--ff-only', `origin/${target}`]), 'git merge --ff-only'));
    state.to = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    await step('Abhängigkeiten installieren', async () =>
      must(await run('npm', ['ci', '--no-audit', '--no-fund'], root, 10 * 60_000), 'npm ci'));
    await step('Bauen', async () => must(await run('npm', ['run', 'build'], root, 10 * 60_000), 'npm run build'));

    if (options.agents) {
      await step('Agents aktualisieren', async () => queueAgentUpdates(ctx, actor), (r) => r);
    }
    state.steps.push({ name: 'Neustart', status: 'running' });
    const restart = ctx.restart ?? (process.env.INVOCATION_ID ? defaultRestart : null);
    if (restart) {
      state.restarting = true;
      state.steps[state.steps.length - 1] = { name: 'Neustart', status: 'done', detail: 'Server startet in wenigen Sekunden neu' };
    } else {
      state.steps[state.steps.length - 1] = { name: 'Neustart', status: 'done', detail: 'Bitte den Server manuell neu starten (kein systemd erkannt)' };
    }
    state.state = 'success';
    state.finished_at = new Date().toISOString();
    recordResult(ctx, actor, 'success', `${state.from} → ${state.to}`);
    audit(ctx.db, {
      actor_type: actor.type, actor_id: actor.id, actor_label: actor.label,
      action: 'system.update.finish', target_type: 'system', result: 'success',
      detail: { from: state.from, to: state.to },
    });
    restart?.();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    // Nach einem Fehlschlag auf den vorherigen, lauffähigen Stand zurück (Baum war vorher sauber).
    if (changed && beforeHash) {
      try {
        await step('Zurücksetzen auf vorherigen Stand', async () => {
          if (beforeBranch && beforeBranch !== 'HEAD') await git(root, ['checkout', '-f', beforeBranch]);
          must(await git(root, ['reset', '--hard', beforeHash]), 'git reset');
          await run('npm', ['ci', '--no-audit', '--no-fund'], root, 10 * 60_000);
          must(await run('npm', ['run', 'build'], root, 10 * 60_000), 'Neu-Bau');
        });
      } catch {
        state.error += ' – Rückabwicklung ebenfalls fehlgeschlagen, bitte manuell prüfen.';
      }
    }
    state.state = 'failed'; // erst nach der Rückabwicklung, damit Beobachter nicht zu früh „fertig“ sehen
    state.finished_at = new Date().toISOString();
    recordResult(ctx, actor, 'failed', state.error ?? 'unbekannter Fehler');
    audit(ctx.db, {
      actor_type: actor.type, actor_id: actor.id, actor_label: actor.label,
      action: 'system.update.finish', target_type: 'system', result: 'failure',
      detail: { error: state.error },
    });
  }
}
