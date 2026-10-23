import { spawn } from 'node:child_process';
import { parseArgs, flagString } from '../args.js';
import { api, CliError } from '../client.js';
import { loadConfig } from '../config.js';
import type { Ctx } from '../io.js';
import { resolveProject } from '../project.js';

interface SecretMeta {
  id: string;
  name: string;
  kind: string;
  environment: string;
}

/**
 * devdeck env run -- <befehl>: Secret-Werte der Umgebung nur in die Prozess-Umgebung des
 * Kindprozesses injizieren (nie auf Platte, nie in die Ausgabe). Jeder Abruf wird auditiert.
 */
export async function envRun(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.rest.length === 0) throw new CliError('Aufruf: devdeck env run [--environment development] -- <befehl> [args]', 'USAGE', 2);
  const config = loadConfig(ctx.env);
  const p = await resolveProject(config, ctx.cwd, { project: flagString(args, 'project'), env: ctx.env });
  const environment = flagString(args, 'environment') ?? 'development';
  const secrets = await api<SecretMeta[]>(
    config,
    'GET',
    `/api/projects/${p.projectId}/secrets?environment=${encodeURIComponent(environment)}&limit=500`,
  );
  const injected: Record<string, string> = {};
  let denied = 0;
  for (const s of secrets.filter((x) => x.kind === 'env')) {
    try {
      const v = await api<{ has_value: boolean; value?: string }>(
        config,
        'GET',
        `/api/projects/${p.projectId}/secrets/${s.id}/values`,
      );
      if (v.has_value && v.value !== undefined) injected[s.name] = v.value;
    } catch {
      denied++;
    }
  }
  ctx.io.err(`[devdeck] ${Object.keys(injected).length} Secret(s) aus "${environment}" injiziert${denied ? `, ${denied} ohne Berechtigung übersprungen` : ''}.`);
  const [cmd, ...cmdArgs] = args.rest as [string, ...string[]];
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: ctx.cwd,
      env: { ...ctx.env, ...injected },
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      ctx.io.err(`Befehl konnte nicht gestartet werden: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
