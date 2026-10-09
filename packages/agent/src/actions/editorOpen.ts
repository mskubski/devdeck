import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';

/** Feste Editor-Allowlist – keine freien Programme/Argumente (Spec §28). */
const EDITORS: Record<string, string[]> = {
  code: [],
  'code-insiders': [],
  cursor: [],
  subl: [],
  nano: [],
  vim: [],
  notepad: [],
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

/** editor.open – öffnet den allowlisteden Editor im Workspace. */
registerAction('editor.open', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const requested =
    typeof ctx.payload.editor === 'string' && ctx.payload.editor ? ctx.payload.editor : null;

  const candidates = requested ? [requested] : Object.keys(EDITORS);
  for (const name of candidates) {
    const extraArgs = EDITORS[name];
    if (!extraArgs) {
      throw new AppError('FORBIDDEN', `Editor nicht in der Allowlist: ${name}`);
    }
    if (!whichSync(name)) continue;
    const child = spawn(name, [...extraArgs], {
      cwd: workspacePath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { editor: name, local_path: workspacePath };
  }
  throw new AppError('TOOL_MISSING', `Kein allowlistedes Editor verfügbar: ${candidates.join(', ')}`);
});
