import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { loadManifest } from '../manifest.js';

/**
 * env.refresh – `.env` und Secret Files aus dem Vault projizieren.
 * `.env` wird nie gespeichert, nur frisch geschrieben (Modus 0600).
 */
registerAction('env.refresh', async (ctx) => {
  const workspacePath = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const workspaceId =
    typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;
  const manifest = loadManifest(workspacePath);

  const res = await ctx.client.request<{
    env?: Record<string, string>;
    files?: Array<{ target_path: string; content_base64: string }>;
  }>('POST', '/api/agent/secrets/fetch', {
    body: { workspace_id: workspaceId, local_path: workspacePath, include: ['env', 'files'] },
  });
  if (res.status !== 200 || !res.data) {
    throw new AppError(
      'SECRET_UNAVAILABLE',
      res.error?.message ?? 'Secrets konnten nicht bezogen werden (Berechtigung/Vault)',
    );
  }

  const envTarget = path.basename(manifest?.environment?.target ?? '.env');
  const envPath = path.join(workspacePath, envTarget);
  let envWritten = false;
  if (res.data.env && Object.keys(res.data.env).length > 0) {
    const lines = Object.entries(res.data.env).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    envWritten = true;
  }

  const filesWritten: string[] = [];
  for (const file of res.data.files ?? []) {
    const target = path.resolve(workspacePath, path.basename(file.target_path));
    if (!target.startsWith(path.resolve(workspacePath) + path.sep)) {
      throw new AppError('FORBIDDEN', 'Secret-Datei-Zielpfad außerhalb des Workspaces');
    }
    fs.writeFileSync(target, Buffer.from(file.content_base64, 'base64'), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    filesWritten.push(path.basename(file.target_path));
  }

  // .env niemals committen
  const gitignore = path.join(workspacePath, '.gitignore');
  let ignoreUpdated = false;
  if (fs.existsSync(gitignore)) {
    const current = fs.readFileSync(gitignore, 'utf8');
    const needed = [envTarget, ...filesWritten].filter(
      (entry) => !current.split('\n').some((l) => l.trim() === entry),
    );
    if (needed.length > 0) {
      fs.appendFileSync(gitignore, `\n# DevDeck: Secrets niemals committen\n${needed.join('\n')}\n`);
      ignoreUpdated = true;
    }
  }

  return {
    local_path: workspacePath,
    env_written: envWritten,
    files: filesWritten,
    gitignore_updated: ignoreUpdated,
  };
});
