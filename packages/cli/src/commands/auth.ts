import { parseArgs, flagString } from '../args.js';
import { api, CliError } from '../client.js';
import { loadConfig, saveConfig } from '../config.js';
import type { Ctx } from '../io.js';

export async function login(ctx: Ctx, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const current = loadConfig(ctx.env);
  const serverUrl = (flagString(args, 'server') ?? current.serverUrl).replace(/\/+$/, '');
  const email = flagString(args, 'email') ?? ctx.env.DEVDECK_EMAIL ?? (await ctx.io.prompt('E-Mail: '));
  const password = ctx.env.DEVDECK_PASSWORD ?? (await ctx.io.prompt('Passwort: ', true));
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new CliError(`Server nicht erreichbar: ${serverUrl}`, 'UNREACHABLE');
  }
  if (!res.ok) throw new CliError('Anmeldung fehlgeschlagen', 'UNAUTHORIZED');
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('dd_session='));
  const token = cookie?.split(';')[0]?.slice('dd_session='.length);
  if (!token) throw new CliError('Server lieferte kein Sitzungs-Token', 'INTERNAL');
  saveConfig(ctx.env, { serverUrl, token, email: email.trim().toLowerCase() });
  ctx.io.out(`Angemeldet als ${email} an ${serverUrl}`);
  return 0;
}

export async function logout(ctx: Ctx): Promise<number> {
  const config = loadConfig(ctx.env);
  if (config.token) {
    await api(config, 'POST', '/api/auth/logout').catch(() => undefined);
  }
  saveConfig(ctx.env, { ...config, token: null });
  ctx.io.out('Abgemeldet.');
  return 0;
}

export async function whoami(ctx: Ctx): Promise<number> {
  const config = loadConfig(ctx.env);
  const me = await api<{ user: { email: string; system_role: string }; memberships: Array<{ slug: string; role: string }> }>(
    config,
    'GET',
    '/api/auth/me',
  );
  ctx.io.out(`${me.user.email} (${me.user.system_role}) @ ${config.serverUrl}`);
  for (const m of me.memberships) ctx.io.out(`  ${m.slug}  [${m.role}]`);
  return 0;
}
