import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';

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

/** Plattform-Terminals, jeweils mit festen Argumenten (keine freien Command-Strings). */
const TERMINALS: Array<{ bin: string; args: (cwd: string) => string[] }> = [
  { bin: 'x-terminal-emulator', args: () => [] },
  { bin: 'gnome-terminal', args: (cwd) => [`--working-directory=${cwd}`] },
  { bin: 'konsole', args: (cwd) => [`--workdir`, cwd] },
  { bin: 'xterm', args: () => [] },
];

/** terminal.open – öffnet ein Terminal ausschließlich im Workspace-Verzeichnis. */
registerAction('terminal.open', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);

  if (process.platform === 'darwin') {
    const child = spawn('open', ['-a', 'Terminal', workspacePath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { terminal: 'Terminal.app', local_path: workspacePath };
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/k'], {
      cwd: workspacePath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { terminal: 'cmd.exe', local_path: workspacePath };
  }

  for (const terminal of TERMINALS) {
    if (!whichSync(terminal.bin)) continue;
    const child = spawn(terminal.bin, terminal.args(workspacePath), {
      cwd: workspacePath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { terminal: terminal.bin, local_path: workspacePath };
  }
  throw new AppError('TOOL_MISSING', 'Kein unterstütztes Terminal gefunden');
});
