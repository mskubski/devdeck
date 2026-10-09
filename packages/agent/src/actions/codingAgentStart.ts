import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';

/** Erlaubte Coding Agents (Spezifikation §18) – starten IM lokalen Workspace. */
const CODING_AGENTS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
};

function whichSync(bin: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, `${bin}${ext}`))) return true;
      } catch {
        /* ungültiger PATH-Eintrag */
      }
    }
  }
  return false;
}

/**
 * coding_agent.start – startet Claude Code / Codex DIREKT im lokalen
 * Projektverzeichnis (niemals auf einer versteckten Kopie des Servers).
 */
registerAction('coding_agent.start', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const requested =
    typeof ctx.payload.agent === 'string' && ctx.payload.agent ? ctx.payload.agent : 'claude';
  const binary = CODING_AGENTS[requested];
  if (!binary) {
    throw new AppError('FORBIDDEN', `Coding Agent nicht erlaubt: ${requested}`);
  }
  if (!fs.existsSync(path.join(workspacePath, '.devdeck'))) {
    throw new AppError('NOT_FOUND', 'Workspace hat kein .devdeck/ – zuerst context.refresh ausführen');
  }
  if (!whichSync(binary)) {
    throw new AppError('TOOL_MISSING', `Coding Agent nicht installiert: ${binary}`);
  }

  const child = spawn(binary, [], {
    cwd: workspacePath,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const sessionId =
    typeof ctx.payload.session_id === 'string' ? ctx.payload.session_id : null;
  if (sessionId) {
    await ctx.client.request('POST', `/api/agent/sessions/${sessionId}/state`, {
      body: { state: 'started' },
    });
  }

  return { agent: binary, pid: child.pid, local_path: workspacePath, session_id: sessionId };
});
