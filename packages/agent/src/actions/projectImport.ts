import fs from 'node:fs';
import path from 'node:path';
import { AppError, parseChangelog, parseSecrets, parseTasks } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';

const CHANGELOG_FILES = ['CHANGELOG.md', 'docs/CHANGELOG.md'];
const TASK_FILES = ['ROADMAP.md', 'docs/ROADMAP.md', 'TODO.md', 'docs/TODO.md'];
const SECRET_FILES = [
  '.env', '.env.local', '.env.development', '.env.staging', '.env.production',
  'credentials.md', 'CREDENTIALS.md', 'docs/credentials.md',
];
const MAX_FILE_BYTES = 1024 * 1024;

function readIfSmall(root: string, rel: string): string | null {
  const file = path.join(root, rel);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function firstExisting(root: string, candidates: string[]): { rel: string; text: string } | null {
  for (const rel of candidates) {
    const text = readIfSmall(root, rel);
    if (text !== null) return { rel, text };
  }
  return null;
}

function environmentFor(rel: string, fallback: string): string {
  const m = /\.env\.(development|staging|production)$/.exec(rel);
  return m ? m[1]! : fallback;
}

/**
 * project.import – liest CHANGELOG.md, ROADMAP/TODO.md und .env/credentials.md IM Workspace und meldet
 * sie dem Server. `dry_run` (Standard) liefert nur eine Vorschau (Secret-Namen und -Längen, nie Werte).
 * Das Ergebnis dieser Aktion enthält niemals Secret-Werte.
 */
registerAction('project.import', async (ctx) => {
  const root = resolveWorkspacePath(ctx, ctx.payload.local_path);
  const workspaceId = typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;
  if (!workspaceId) throw new AppError('VALIDATION', 'workspace_id ist erforderlich');
  const environment = ['development', 'staging', 'production'].includes(String(ctx.payload.environment))
    ? String(ctx.payload.environment)
    : 'production';

  const files: string[] = [];
  const changelogFile = firstExisting(root, CHANGELOG_FILES);
  const changelog = changelogFile ? parseChangelog(changelogFile.text) : [];
  if (changelogFile) files.push(changelogFile.rel);
  const taskFile = firstExisting(root, TASK_FILES);
  const tasks = taskFile ? parseTasks(taskFile.text) : [];
  if (taskFile) files.push(taskFile.rel);

  const secrets: Array<{ name: string; value: string; environment: string; source: string }> = [];
  for (const rel of SECRET_FILES) {
    const text = readIfSmall(root, rel);
    if (text === null) continue;
    files.push(rel);
    const env = environmentFor(rel, environment);
    for (const s of parseSecrets(text, rel.toLowerCase().endsWith('.md') ? 'md' : 'env')) {
      secrets.push({ ...s, environment: env, source: rel });
    }
  }

  const res = await ctx.client.request<Record<string, unknown>>('POST', '/api/agent/import', {
    body: {
      workspace_id: workspaceId,
      dry_run: ctx.payload.dry_run !== false,
      overwrite: ctx.payload.overwrite === true,
      changelog, tasks, secrets,
    },
    timeoutMs: 60_000,
  });
  if (res.status !== 200 || !res.data) {
    throw new AppError(
      res.status === 403 ? 'FORBIDDEN' : 'INTERNAL',
      res.error?.message ?? `Import vom Server abgelehnt (HTTP ${res.status})`,
    );
  }
  return { files, ...res.data };
});
