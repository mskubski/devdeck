import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from '../../server/test/helpers.js';
import { main } from '../src/index.js';
import { parseArgs } from '../src/args.js';

describe('DevDeck CLI (Phase H, Basis)', () => {
  let srv: TestServer;
  let cookie: string;
  let tmp: string;
  let workspace: string;
  let projectId: string;
  let out: string[];
  let err: string[];
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    DEVDECK_CLI_CONFIG: path.join(tmp, 'cli.json'),
    DEVDECK_AGENT_CONFIG: path.join(tmp, 'no-agent.json'),
    DEVDECK_SERVER: srv.base,
    DEVDECK_EMAIL: TEST_ADMIN.email,
    DEVDECK_PASSWORD: TEST_ADMIN.password,
  });
  const run = (argv: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    main(argv, {
      env: { ...env(), ...extraEnv },
      cwd: workspace,
      io: {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        prompt: async () => {
          throw new Error('Prompt nicht erwartet');
        },
      },
    });

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-cli-'));
    workspace = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(workspace, '.devdeck'), { recursive: true });
    const project = await srv.request('POST', '/api/projects', { cookie, body: { name: 'WebApp' } });
    projectId = project.body.data.id;
    out = [];
    err = [];
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parseArgs trennt Flags, Positionale und Rest nach --', () => {
    const a = parseArgs(['add', 'Titel', 'mehr', '--priority', '4', '--print', '--', 'npm', 'test', '--x']);
    expect(a.positional).toEqual(['add', 'Titel', 'mehr']);
    expect(a.flags).toEqual({ priority: '4', print: true });
    expect(a.rest).toEqual(['npm', 'test', '--x']);
  });

  it('verlangt Anmeldung und speichert das Token mit Modus 0600', async () => {
    expect(await run(['task', 'add', 'X', '--project', 'webapp'])).toBe(1);
    expect(err.join('\n')).toContain('devdeck login');

    expect(await run(['login'])).toBe(0);
    const file = path.join(tmp, 'cli.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBeTruthy();

    out.length = 0;
    expect(await run(['whoami'], { DEVDECK_TOKEN: '' })).toBe(0);
    expect(out.join('\n')).toContain(TEST_ADMIN.email);
  });

  it('legt Task, Changelog und Decision an und erkennt das Projekt per project.json', async () => {
    await run(['login']);
    fs.writeFileSync(
      path.join(workspace, '.devdeck', 'project.json'),
      JSON.stringify({ project_id: projectId }),
    );
    expect(await run(['task', 'add', 'Backup prüfen', '--priority', '5'])).toBe(0);
    expect(await run(['changelog', 'add', 'CLI hinzugefügt', '--version', '0.2.0'])).toBe(0);
    expect(await run(['decision', 'add', 'Kein Framework', '--rationale', 'klein'])).toBe(0);

    const tasks = await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie });
    expect(tasks.body.data[0]).toMatchObject({ title: 'Backup prüfen', priority: 5 });
    const log = await srv.request('GET', `/api/projects/${projectId}/changelog`, { cookie });
    expect(log.body.data[0]).toMatchObject({ summary: 'CLI hinzugefügt', version: '0.2.0' });
    const dec = await srv.request('GET', `/api/projects/${projectId}/decisions`, { cookie });
    expect(dec.body.data[0].title).toBe('Kein Framework');
  });

  it('erkennt das Projekt über den registrierten Workspace-Pfad und merkt es sich', async () => {
    await run(['login']);
    const machine = await srv.enroll(cookie);
    const reg = await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie,
      body: { machine_id: machine.machineId, local_path: workspace },
    });
    expect(reg.status).toBeLessThan(300);
    expect(await run(['task', 'add', 'Per Pfad erkannt'])).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.devdeck', 'project.json'), 'utf8'));
    expect(saved.project_id).toBe(projectId);
  });

  it('Session start/finish und Handover-Import', async () => {
    await run(['login']);
    expect(await run(['session', 'start', '--goal', 'CLI testen', '--project', 'webapp'])).toBe(0);
    const active = JSON.parse(fs.readFileSync(path.join(workspace, '.devdeck', 'session.json'), 'utf8'));
    expect(await run(['session', 'start', '--project', 'webapp'])).toBe(1); // läuft schon

    const file = path.join(tmp, 'handover.json');
    fs.writeFileSync(file, JSON.stringify({ goal: 'CLI testen', completed: ['Basis'], notes: 'ok' }));
    expect(await run(['handover', 'import', file, '--project', 'webapp'])).toBe(0);
    const handovers = await srv.request('GET', `/api/projects/${projectId}/handovers`, { cookie });
    expect(handovers.body.data[0].payload.completed).toEqual(['Basis']);

    expect(await run(['session', 'finish', '--project', 'webapp'])).toBe(0);
    expect(fs.existsSync(path.join(workspace, '.devdeck', 'session.json'))).toBe(false);
    const session = await srv.request('GET', `/api/projects/${projectId}/sessions/${active.session_id}`, { cookie });
    expect(session.body.data.status).toBe('closed');
  });

  it('secret list zeigt nur Metadaten; env run injiziert Werte ohne sie auszugeben', async () => {
    await run(['login']);
    const created = await srv.request('POST', `/api/projects/${projectId}/secrets`, {
      cookie,
      body: { name: 'MY_TOKEN', kind: 'env', environment: 'development' },
    });
    await srv.request('POST', `/api/projects/${projectId}/secrets/${created.body.data.id}/values`, {
      cookie,
      body: { value: 'geheim-12345' },
    });

    out.length = 0;
    expect(await run(['secret', 'list', '--project', 'webapp'])).toBe(0);
    expect(out.join('\n')).toContain('MY_TOKEN');
    expect(out.join('\n')).not.toContain('geheim-12345');

    const outFile = path.join(tmp, 'env-out.txt');
    const code = await run([
      'env', 'run', '--project', 'webapp', '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(outFile)}, process.env.MY_TOKEN ?? 'FEHLT')`,
    ]);
    expect(code).toBe(0);
    expect(fs.readFileSync(outFile, 'utf8')).toBe('geheim-12345');
    expect([...out, ...err].join('\n')).not.toContain('geheim-12345');
  });

  it('Launcher: startet den Agent im Workspace, fährt Session hoch und schließt sie danach', async () => {
    await run(['login']);
    fs.writeFileSync(path.join(workspace, '.devdeck', 'project.json'), JSON.stringify({ project_id: projectId }));
    fs.writeFileSync(path.join(workspace, '.devdeck', 'CONTEXT.md'), '# Kontext');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(tmp, 'launched.json');
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2), session: process.env.DEVDECK_SESSION_ID}));\n`,
      { mode: 0o755 },
    );
    const PATH = `${bin}${path.delimiter}${process.env.PATH}`;

    const code = await run(['claude', '--goal', 'Launcher testen', '--', '--model', 'x'], { PATH });
    expect(code).toBe(0);
    const launched = JSON.parse(fs.readFileSync(marker, 'utf8'));
    expect(fs.realpathSync(launched.cwd)).toBe(fs.realpathSync(workspace));
    expect(launched.args).toEqual(['--model', 'x']);
    const sessions = await srv.request('GET', `/api/projects/${projectId}/sessions`, { cookie });
    expect(sessions.body.data).toHaveLength(1);
    expect(sessions.body.data[0]).toMatchObject({ id: launched.session, status: 'closed', agent_name: 'claude', goal: 'Launcher testen' });
    expect(fs.existsSync(path.join(workspace, '.devdeck', 'session.json'))).toBe(false);

    // Nicht installiert → klarer Fehler; nicht erlaubte Programme gibt es nicht als Befehl
    expect(await run(['codex'], { PATH: bin })).toBe(1);
    expect(err.join('\n')).toContain('nicht installiert');
    expect(await run(['bash'])).toBe(2);
  });

  it('gibt Hilfe aus und meldet unbekannte Befehle', async () => {
    expect(await run(['help'])).toBe(0);
    expect(await run(['unsinn'])).toBe(2);
  });
});
