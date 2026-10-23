import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, flagString, type ParsedArgs } from '../args.js';
import { api, CliError } from '../client.js';
import { loadConfig, type CliConfig } from '../config.js';
import type { Ctx } from '../io.js';
import { parseChangelog, parseSecrets, parseTasks } from '../import/parsers.js';
import { resolveProject, type ResolvedProject } from '../project.js';

const CHANGELOG_FILES = ['CHANGELOG.md', 'docs/CHANGELOG.md'];
const TASK_FILES = ['ROADMAP.md', 'docs/ROADMAP.md', 'TODO.md', 'docs/TODO.md'];
const SECRET_FILES = ['.env', '.env.local', '.env.development', '.env.staging', '.env.production', 'credentials.md', 'CREDENTIALS.md', 'docs/credentials.md'];

interface Target {
  config: CliConfig;
  p: ResolvedProject;
  apply: boolean;
  args: ParsedArgs;
}

function findFile(root: string, candidates: string[], explicit?: string): string | null {
  if (explicit) {
    const f = path.resolve(root, explicit);
    if (!fs.existsSync(f)) throw new CliError(`Datei nicht gefunden: ${explicit}`, 'NOT_FOUND');
    return f;
  }
  for (const c of candidates) {
    const f = path.join(root, c);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const rel = (root: string, f: string): string => path.relative(root, f) || f;

async function importChangelog(ctx: Ctx, t: Target): Promise<void> {
  const file = findFile(t.p.root, CHANGELOG_FILES, flagString(t.args, 'file'));
  if (!file) return void ctx.io.out('Changelog: keine CHANGELOG.md gefunden.');
  const items = parseChangelog(fs.readFileSync(file, 'utf8'));
  const existing = await api<Array<{ summary: string; version: string | null }>>(
    t.config, 'GET', `/api/projects/${t.p.projectId}/changelog`,
  );
  const known = new Set(existing.map((e) => `${e.version ?? ''}|${e.summary}`));
  const fresh = items.filter((i) => !known.has(`${i.version ?? ''}|${i.summary}`));
  ctx.io.out(`Changelog (${rel(t.p.root, file)}): ${items.length} Einträge, ${fresh.length} neu, ${items.length - fresh.length} bereits vorhanden.`);
  if (!t.apply) return;
  // Älteste zuerst, damit die Reihenfolge in der Historie stimmt
  for (const i of [...fresh].reverse()) {
    await api(t.config, 'POST', `/api/projects/${t.p.projectId}/changelog`, {
      version: i.version, summary: i.summary, body: i.body, date: i.date ?? undefined,
    });
  }
  ctx.io.out(`  → ${fresh.length} Changelog-Einträge importiert.`);
}

async function importTasks(ctx: Ctx, t: Target): Promise<void> {
  const file = findFile(t.p.root, TASK_FILES, flagString(t.args, 'file'));
  if (!file) {
    if (!t.args.flags.create) {
      return void ctx.io.out('Tasks: keine ROADMAP.md/TODO.md gefunden. Mit --create wird ROADMAP.md aus den DevDeck-Tasks erzeugt.');
    }
    const tasks = await api<Array<{ title: string; status: string; priority: number }>>(
      t.config, 'GET', `/api/projects/${t.p.projectId}/tasks`,
    );
    const lines = ['# Roadmap', '', '> Checkbox-Liste; wird von `devdeck import tasks` nach DevDeck übernommen. Priorität optional mit `(P1)`–`(P5)`.', '', '## Aufgaben', ''];
    for (const k of tasks) lines.push(`- [${k.status === 'done' ? 'x' : ' '}] ${k.title}${k.priority !== 3 ? ` (P${k.priority})` : ''}`);
    const target = path.join(t.p.root, 'ROADMAP.md');
    if (t.apply) fs.writeFileSync(target, `${lines.join('\n')}\n`);
    return void ctx.io.out(`Tasks: ROADMAP.md ${t.apply ? 'erstellt' : 'würde erstellt'} mit ${tasks.length} Einträgen${t.apply ? '' : ' (--apply zum Schreiben)'}.`);
  }
  const items = parseTasks(fs.readFileSync(file, 'utf8'));
  const existing = await api<Array<{ title: string }>>(t.config, 'GET', `/api/projects/${t.p.projectId}/tasks`);
  const known = new Set(existing.map((e) => e.title));
  const fresh = items.filter((i) => !known.has(i.title));
  const done = fresh.filter((i) => i.done).length;
  ctx.io.out(`Tasks (${rel(t.p.root, file)}): ${items.length} Einträge, ${fresh.length} neu (${done} erledigt), ${items.length - fresh.length} bereits vorhanden.`);
  if (!t.apply) return;
  for (const i of fresh) {
    await api(t.config, 'POST', `/api/projects/${t.p.projectId}/tasks`, {
      title: i.title,
      description: i.section ? `Abschnitt: ${i.section}` : undefined,
      priority: i.priority,
      status: i.done ? 'done' : 'open',
    });
  }
  ctx.io.out(`  → ${fresh.length} Tasks importiert.`);
}

function environmentFor(file: string, fallback: string): string {
  const m = /\.env\.(development|staging|production)$/.exec(file);
  return m ? m[1]! : fallback;
}

/** Secrets: standardmäßig nur Vorschau mit Namen – Werte werden nie ausgegeben. */
async function importSecrets(ctx: Ctx, t: Target): Promise<void> {
  const explicit = flagString(t.args, 'file');
  const files = explicit
    ? [findFile(t.p.root, [], explicit)!]
    : SECRET_FILES.map((c) => path.join(t.p.root, c)).filter((f) => fs.existsSync(f));
  if (files.length === 0) return void ctx.io.out('Secrets: keine .env/credentials.md gefunden.');

  const fallbackEnv = flagString(t.args, 'environment') ?? 'development';
  const existing = await api<Array<{ id: string; name: string; environment: string }>>(
    t.config, 'GET', `/api/projects/${t.p.projectId}/secrets?limit=500`,
  );
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const file of files) {
    const env = environmentFor(file, fallbackEnv);
    const kind = file.toLowerCase().endsWith('.md') ? 'md' : 'env';
    const items = parseSecrets(fs.readFileSync(file, 'utf8'), kind);
    ctx.io.out(`Secrets (${rel(t.p.root, file)} → ${env}): ${items.length} Werte erkannt`);
    for (const item of items) {
      const hit = existing.find((e) => e.name === item.name && e.environment === env);
      const action = hit ? (t.args.flags.overwrite ? 'überschreiben' : 'überspringen (existiert)') : 'neu';
      ctx.io.out(`  ${item.name}  [${action}, ${item.value.length} Zeichen]`);
      if (!t.apply) continue;
      if (hit && !t.args.flags.overwrite) { skipped++; continue; }
      const secretId = hit
        ? hit.id
        : (await api<{ id: string }>(t.config, 'POST', `/api/projects/${t.p.projectId}/secrets`, {
            name: item.name, kind: 'env', environment: env, description: `Importiert aus ${rel(t.p.root, file)}`,
          })).id;
      await api(t.config, 'POST', `/api/projects/${t.p.projectId}/secrets/${secretId}/values`, { value: item.value });
      hit ? updated++ : created++;
    }
  }
  if (t.apply) {
    ctx.io.out(`  → ${created} neu, ${updated} aktualisiert, ${skipped} übersprungen.`);
    ctx.io.out('  Hinweis: Die Quelldateien enthalten die Werte weiterhin im Klartext – nach Prüfung entfernen (credentials.md) bzw. nicht committen (.env).');
  } else {
    ctx.io.out('  (Vorschau – mit --apply in den Vault übernehmen.)');
  }
}

/** devdeck import <changelog|tasks|secrets|all> [--apply] [--file f] [--environment e] [--overwrite] [--create] */
export async function importCmd(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const what = args.positional[0];
  if (!what || !['changelog', 'tasks', 'secrets', 'all'].includes(what)) {
    throw new CliError('Aufruf: devdeck import <changelog|tasks|secrets|all> [--apply] [--file <datei>] [--environment e] [--overwrite] [--create]', 'USAGE', 2);
  }
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
  const t: Target = { config, p, apply: Boolean(args.flags.apply), args };
  ctx.io.out(`Projekt: ${p.projectName} (${p.root})${t.apply ? '' : '  – Vorschau, nichts wird geschrieben'}`);
  if (what === 'changelog' || what === 'all') await importChangelog(ctx, t);
  if (what === 'tasks' || what === 'all') await importTasks(ctx, t);
  if (what === 'secrets' || what === 'all') await importSecrets(ctx, t);
  if (!t.apply) ctx.io.out('\nMit --apply tatsächlich importieren.');
  return 0;
}
