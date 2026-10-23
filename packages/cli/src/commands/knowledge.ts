import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, flagString } from '../args.js';
import { api, CliError } from '../client.js';
import { loadConfig } from '../config.js';
import type { Ctx } from '../io.js';
import { resolveProject } from '../project.js';

async function project(ctx: Ctx, args: ReturnType<typeof parseArgs>) {
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
  return { config, p };
}

function needText(args: ReturnType<typeof parseArgs>, what: string): string {
  const text = args.positional.slice(1).join(' ').trim();
  if (!text) throw new CliError(`Bitte ${what} angeben.`, 'USAGE', 2);
  return text;
}

export async function task(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.positional[0] !== 'add') throw new CliError('Aufruf: devdeck task add <titel> [--priority 1-5] [--description ...]', 'USAGE', 2);
  const { config, p } = await project(ctx, args);
  const created = await api<{ id: string; title: string }>(config, 'POST', `/api/projects/${p.projectId}/tasks`, {
    title: needText(args, 'einen Titel'),
    description: flagString(args, 'description'),
    priority: Number(flagString(args, 'priority') ?? 3),
  });
  ctx.io.out(`Task angelegt: ${created.title} (${created.id})`);
  return 0;
}

export async function changelog(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.positional[0] !== 'add') throw new CliError('Aufruf: devdeck changelog add <zusammenfassung> [--version x] [--body ...]', 'USAGE', 2);
  const { config, p } = await project(ctx, args);
  const created = await api<{ id: string }>(config, 'POST', `/api/projects/${p.projectId}/changelog`, {
    summary: needText(args, 'eine Zusammenfassung'),
    version: flagString(args, 'version'),
    body: flagString(args, 'body'),
  });
  ctx.io.out(`Changelog-Eintrag angelegt (${created.id})`);
  return 0;
}

export async function decision(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.positional[0] !== 'add') throw new CliError('Aufruf: devdeck decision add <titel> [--rationale ...] [--alternative ...]', 'USAGE', 2);
  const { config, p } = await project(ctx, args);
  const created = await api<{ id: string; status: string }>(config, 'POST', `/api/projects/${p.projectId}/decisions`, {
    title: needText(args, 'einen Titel'),
    rationale: flagString(args, 'rationale'),
    context: flagString(args, 'context'),
    alternative: flagString(args, 'alternative'),
  });
  ctx.io.out(`Entscheidung angelegt (${created.id}, Status: ${created.status})`);
  return 0;
}

interface SecretMeta {
  id: string;
  name: string;
  kind: string;
  environment: string;
  description?: string | null;
}

/** Nur Metadaten – niemals Werte (Konflikt K4 im Plan). */
export async function secret(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.positional[0] !== 'list') throw new CliError('Aufruf: devdeck secret list [--environment development]', 'USAGE', 2);
  const { config, p } = await project(ctx, args);
  const env = flagString(args, 'environment');
  const secrets = await api<SecretMeta[]>(
    config,
    'GET',
    `/api/projects/${p.projectId}/secrets${env ? `?environment=${encodeURIComponent(env)}` : ''}`,
  );
  if (secrets.length === 0) ctx.io.out('Keine Secrets.');
  for (const s of secrets) ctx.io.out(`${s.environment.padEnd(12)} ${s.kind.padEnd(5)} ${s.name}${s.description ? `  – ${s.description}` : ''}`);
  return 0;
}

const SESSION_FILE = (root: string) => path.join(root, '.devdeck', 'session.json');

export function readActiveSession(root: string): { session_id: string; project_id: string } | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE(root), 'utf8'));
  } catch {
    return null;
  }
}

export function writeActiveSession(root: string, data: { session_id: string; project_id: string } | null): void {
  const file = SESSION_FILE(root);
  if (!data) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function startSession(
  ctx: Ctx,
  opts: { project?: string; goal?: string; agentName?: string },
): Promise<{ sessionId: string; root: string; projectId: string; config: ReturnType<typeof loadConfig> }> {
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: opts.project, env: ctx.env });
  const active = readActiveSession(p.root);
  if (active && active.project_id === p.projectId) {
    throw new CliError(`Es läuft bereits eine Session (${active.session_id}). Zuerst: devdeck session finish`, 'CONFLICT');
  }
  const session = await api<{ id: string }>(config, 'POST', `/api/projects/${p.projectId}/sessions`, {
    goal: opts.goal ?? null,
    workspace_id: p.workspaceId,
    agent_name: opts.agentName ?? null,
  });
  writeActiveSession(p.root, { session_id: session.id, project_id: p.projectId });
  return { sessionId: session.id, root: p.root, projectId: p.projectId, config };
}

export async function finishSession(ctx: Ctx, opts: { project?: string; session?: string }): Promise<string> {
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: opts.project, env: ctx.env });
  const sessionId = opts.session ?? readActiveSession(p.root)?.session_id;
  if (!sessionId) throw new CliError('Keine aktive Session gefunden (--session <id> angeben).', 'NOT_FOUND');
  await api(config, 'POST', `/api/projects/${p.projectId}/sessions/${sessionId}/complete`, {});
  writeActiveSession(p.root, null);
  return sessionId;
}

export async function session(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const sub = args.positional[0];
  if (sub === 'start') {
    const s = await startSession(ctx, { project: flagString(args, 'project'), goal: flagString(args, 'goal'), agentName: flagString(args, 'agent') });
    ctx.io.out(`Session gestartet: ${s.sessionId}`);
    return 0;
  }
  if (sub === 'finish') {
    const id = await finishSession(ctx, { project: flagString(args, 'project'), session: flagString(args, 'session') });
    ctx.io.out(`Session beendet: ${id}`);
    return 0;
  }
  throw new CliError('Aufruf: devdeck session start [--goal ...] | devdeck session finish', 'USAGE', 2);
}

export async function handover(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const file = args.positional[1];
  if (args.positional[0] !== 'import' || !file) {
    throw new CliError('Aufruf: devdeck handover import <datei.json> [--session <id>]', 'USAGE', 2);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8'));
  } catch {
    throw new CliError(`Handover-Datei nicht lesbar oder kein gültiges JSON: ${file}`, 'VALIDATION');
  }
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
  const sessionId = flagString(args, 'session') ?? readActiveSession(p.root)?.session_id;
  if (!sessionId) throw new CliError('Keine aktive Session – zuerst devdeck session start oder --session angeben.', 'NOT_FOUND');
  const created = await api<{ id: string }>(config, 'POST', `/api/projects/${p.projectId}/sessions/${sessionId}/handover`, {
    payload: JSON.stringify(payload),
  });
  ctx.io.out(`Handover importiert (${created.id})`);
  return 0;
}
