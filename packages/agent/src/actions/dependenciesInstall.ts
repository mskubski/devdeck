import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { loadManifest } from '../manifest.js';
import { installDependencies, lockfileHash } from '../dependencies.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** dependencies.install – lokal reproduzieren, nie synchronisieren (Spezifikation §9). */
registerAction('dependencies.install', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const manifest = loadManifest(workspacePath);
  if (!manifest?.package_manager) {
    throw new AppError('MANIFEST_INVALID', 'Kein package_manager im Manifest definiert');
  }
  const result = await installDependencies(workspacePath, manifest);

  const lock = await lockfileHash(workspacePath);
  const statePath = path.join(workspacePath, '.devdeck', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({ lockfile_hash: lock ?? createHash('sha256').update('none').digest('hex') }),
    'utf8',
  );

  return {
    local_path: workspacePath,
    command: result.command,
    output_tail: result.output_tail.slice(-500),
  };
});
