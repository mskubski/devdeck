import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, flagString } from '../args.js';
import { agentAction, CliError } from '../client.js';
import { loadConfig, loadLocalAgent } from '../config.js';
import type { Ctx } from '../io.js';
import { resolveProject } from '../project.js';
import { finishSession, readActiveSession, startSession } from './knowledge.js';

/** Erlaubte Coding Agents (Spezifikation §18) – feste Allowlist, keine freien Befehle. */
const LAUNCHERS = ['claude', 'codex'] as const;
export type Launcher = (typeof LAUNCHERS)[number];

export function isLauncher(name: string): name is Launcher {
  return (LAUNCHERS as readonly string[]).includes(name);
}

function findBinary(name: string, env: NodeJS.ProcessEnv): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* nicht vorhanden */
      }
    }
  }
  return null;
}

/**
 * devdeck claude|codex: Coding Agent im vorbereiteten Workspace starten – mit frisch erzeugtem
 * .devdeck-Kontext und einer Coding Session, die beim Beenden des Agents geschlossen wird.
 */
export async function launch(ctx: Ctx, agentName: Launcher, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const binary = findBinary(agentName, ctx.env);
  if (!binary) throw new CliError(`Coding Agent nicht installiert: ${agentName}`, 'TOOL_MISSING');

  const config = loadConfig(ctx.env);
  const project = flagString(args, 'project');
  const p = await resolveProject(config, ctx.cwd, { project, env: ctx.env });

  if (!args.flags['no-context']) {
    try {
      await agentAction(loadLocalAgent(ctx.env), 'context.refresh', {
        local_path: p.root,
        workspace_id: p.workspaceId,
      });
      ctx.io.err('[devdeck] Kontext aktualisiert.');
    } catch (err) {
      if (!fs.existsSync(path.join(p.root, '.devdeck', 'CONTEXT.md'))) {
        throw new CliError(
          `Kein .devdeck-Kontext vorhanden und Aktualisierung fehlgeschlagen: ${err instanceof Error ? err.message : err}`,
          'NOT_FOUND',
        );
      }
      ctx.io.err('[devdeck] Warnung: Kontext konnte nicht aktualisiert werden, verwende vorhandenen Stand.');
    }
  }

  let sessionId: string | null = null;
  let ownsSession = false;
  if (!args.flags['no-session']) {
    const existing = readActiveSession(p.root);
    if (existing && existing.project_id === p.projectId) {
      sessionId = existing.session_id;
      ctx.io.err(`[devdeck] Setze laufende Session fort: ${sessionId}`);
    } else {
      const s = await startSession(ctx, { project, goal: flagString(args, 'goal'), agentName });
      sessionId = s.sessionId;
      ownsSession = true;
      ctx.io.err(`[devdeck] Session gestartet: ${sessionId}`);
    }
  }

  const code = await new Promise<number>((resolve) => {
    const child = spawn(binary, args.rest, {
      cwd: p.root,
      env: {
        ...ctx.env,
        DEVDECK_PROJECT: p.projectId,
        ...(sessionId ? { DEVDECK_SESSION_ID: sessionId } : {}),
      },
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      ctx.io.err(`Start fehlgeschlagen: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });

  if (ownsSession && sessionId) {
    try {
      await finishSession(ctx, { project, session: sessionId });
      ctx.io.err(`[devdeck] Session beendet. Handover: devdeck handover import <datei.json>`);
    } catch (err) {
      ctx.io.err(`[devdeck] Session konnte nicht beendet werden: ${err instanceof Error ? err.message : err}`);
    }
  }
  return code;
}
