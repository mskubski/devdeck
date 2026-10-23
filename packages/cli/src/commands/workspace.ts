import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, flagString } from '../args.js';
import { agentAction, api, CliError } from '../client.js';
import { loadConfig, loadLocalAgent } from '../config.js';
import type { Ctx } from '../io.js';
import { resolveProject } from '../project.js';

export async function status(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const config = loadConfig(ctx.env);
  let health = 'nicht erreichbar';
  try {
    const res = await fetch(`${config.serverUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    health = res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch {
    /* bleibt nicht erreichbar */
  }
  ctx.io.out(`Server:   ${config.serverUrl} (${health})`);
  ctx.io.out(`Benutzer: ${config.token ? (config.email ?? 'angemeldet') : 'nicht angemeldet'}`);

  const agent = loadLocalAgent(ctx.env);
  if (agent) {
    try {
      const res = await fetch(`http://127.0.0.1:${agent.port}/status`, { signal: AbortSignal.timeout(2000) });
      const s = (await res.json()) as { enrolled: boolean; workspace_root: string };
      ctx.io.out(`Agent:    läuft (${s.enrolled ? 'eingeschrieben' : 'nicht eingeschrieben'}), Root ${s.workspace_root}`);
    } catch {
      ctx.io.out('Agent:    läuft nicht');
    }
  } else {
    ctx.io.out('Agent:    nicht konfiguriert');
  }

  if (config.token) {
    try {
      const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
      ctx.io.out(`Projekt:  ${p.projectName} (${p.root})`);
      const workspaces = await api<Array<{ id: string; local_path: string; status: string; branch: string | null }>>(
        config,
        'GET',
        `/api/projects/${p.projectId}/workspaces`,
      );
      const ws = workspaces.find((w) => w.id === p.workspaceId) ?? workspaces.find((w) => w.local_path === p.root);
      if (ws) ctx.io.out(`Workspace: ${ws.status}${ws.branch ? ` · Branch ${ws.branch}` : ''}`);
    } catch (err) {
      ctx.io.out(`Projekt:  ${err instanceof CliError ? err.message : String(err)}`);
    }
  }
  return 0;
}

export async function sync(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
  const result = await agentAction(loadLocalAgent(ctx.env), 'workspace.sync', {
    local_path: p.root,
    workspace_id: p.workspaceId,
  });
  ctx.io.out(`Sync abgeschlossen: ${JSON.stringify(result)}`);
  return 0;
}

export async function context(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
  await agentAction(loadLocalAgent(ctx.env), 'context.refresh', {
    local_path: p.root,
    workspace_id: p.workspaceId,
  });
  const dir = path.join(p.root, '.devdeck');
  ctx.io.out(`Kontext aktualisiert in ${dir}`);
  if (args.flags.print) {
    for (const name of ['CONTEXT.md', 'CURRENT_STATE.md']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) ctx.io.out(`\n${fs.readFileSync(file, 'utf8')}`);
    }
  }
  return 0;
}
