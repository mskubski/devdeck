import fs from 'node:fs';
import path from 'node:path';
import { AppError, parseChangelog, parseSecrets, parseTasks } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';

const CHANGELOG_NAME = /^(changelog|changes|history|release[-_ ]?notes)(\.md|\.markdown|\.txt)?$/i;
const TASK_NAME = /^(roadmap|todo|to-do|tasks|backlog)(\.md|\.markdown|\.txt)?$/i;
const CREDENTIALS_NAME = /^(credentials|zugangsdaten|secrets)\.md$/i;
const DOC_DIRS = ['', 'docs', 'doc'];
const MAX_FILE_BYTES = 1024 * 1024;

function listFiles(root: string, dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, dir), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Alle Dateien mit passendem Namen (Groß-/Kleinschreibung egal) in Wurzel und docs/. */
function findByName(root: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const dir of DOC_DIRS) {
    for (const name of listFiles(root, dir).sort()) {
      if (regex.test(name)) out.push(dir ? `${dir}/${name}` : name);
    }
  }
  return out;
}

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

/** `.env.<umgebung>` gehört in diese Umgebung, alles andere in die gewählte. */
function environmentFor(rel: string, fallback: string): string {
  const m = /\.env\.(development|staging|production)$/.exec(rel);
  return m ? m[1]! : fallback;
}

/** Reihenfolge der Secret-Dateien: umgebungsspezifische .env, dann .env.local, .env, zuletzt Dokumentation. */
function secretFiles(root: string): string[] {
  const env = listFiles(root, '').filter((n) => /^\.env(\.(local|development|staging|production))?$/.test(n));
  const rank = (n: string): number => (/\.(development|staging|production)$/.test(n) ? 0 : n === '.env.local' ? 1 : 2);
  env.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...env, ...findByName(root, CREDENTIALS_NAME)];
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
  const changelog: ReturnType<typeof parseChangelog> = [];
  for (const rel of findByName(root, CHANGELOG_NAME)) {
    const text = readIfSmall(root, rel);
    if (text === null) continue;
    files.push(rel);
    changelog.push(...parseChangelog(text));
  }
  const tasks: ReturnType<typeof parseTasks> = [];
  for (const rel of findByName(root, TASK_NAME)) {
    const text = readIfSmall(root, rel);
    if (text === null) continue;
    files.push(rel);
    tasks.push(...parseTasks(text));
  }

  // Secrets: derselbe Name+Umgebung kann in mehreren Dateien stehen – die erste (höchste Priorität) gewinnt
  const secrets: Array<{ name: string; value: string; environment: string; source: string }> = [];
  const byKey = new Map<string, { value: string; source: string }>();
  let duplicates = 0;
  let conflicts = 0;
  for (const rel of secretFiles(root)) {
    const text = readIfSmall(root, rel);
    if (text === null) continue;
    files.push(rel);
    const env = environmentFor(rel, environment);
    for (const s of parseSecrets(text, rel.toLowerCase().endsWith('.md') ? 'md' : 'env')) {
      const key = `${s.name}|${env}`;
      const prev = byKey.get(key);
      if (prev) {
        duplicates++;
        if (prev.value !== s.value) conflicts++;
        continue;
      }
      byKey.set(key, { value: s.value, source: rel });
      secrets.push({ ...s, environment: env, source: rel });
    }
  }

  // Zur Diagnose, falls nichts gefunden wurde: welche Textdateien gibt es überhaupt (nur Namen)?
  const filesSeen: string[] = [];
  if (changelog.length === 0 || tasks.length === 0) {
    for (const dir of DOC_DIRS) {
      for (const name of listFiles(root, dir).sort()) {
        if (/\.(md|markdown|txt)$/i.test(name) || /^(changelog|roadmap|todo|history)$/i.test(name)) {
          filesSeen.push(dir ? `${dir}/${name}` : name);
        }
      }
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
  return { files, files_seen: filesSeen.slice(0, 60), duplicates, conflicts, ...res.data };
});
