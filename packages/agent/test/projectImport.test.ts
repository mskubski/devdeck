import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAction } from '../src/actions/index.js';
import '../src/actions/all.js';
import { ServerClient } from '../src/client.js';
import type { AgentConfig } from '../src/config.js';
import { ensureGitExclude, installClaudeRules, writeContextFiles } from '../src/contextFiles.js';
import { startTestServer, TEST_ADMIN, type TestServer } from '../../server/test/helpers.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const FILES = {
  'CONTEXT.md': '# ctx',
  'CURRENT_STATE.md': '# state',
  'RULES.md': '# Regeln\nnach jeder Änderung pushen',
};

describe('Kontextdateien + Claude-Regeln (Agent)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-ctx-'));
    repo = path.join(root, 'app');
    fs.mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.de');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('schreibt Kontext und Regeln, ohne das Repository zu verschmutzen (Sync darf nicht blockieren)', () => {
    const written = writeContextFiles(repo, FILES);
    expect(written.sort()).toEqual(['CONTEXT.md', 'CURRENT_STATE.md', 'RULES.md']);
    expect(fs.readFileSync(path.join(repo, '.claude', 'rules', 'devdeck.md'), 'utf8')).toContain('pushen');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // idempotent
    writeContextFiles(repo, FILES);
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.devdeck\//g)).toHaveLength(1);
    expect(exclude.match(/devdeck\.md/g)).toHaveLength(1);
  });

  it('überspringt Regeln, wenn das Repo eigene enthält (Marker in CLAUDE.md); aktualisiert geänderte Regeln', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '<!-- devdeck:rules-included -->\nEigene Regeln');
    expect(installClaudeRules(repo, FILES['RULES.md'])).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude', 'rules', 'devdeck.md'))).toBe(false);

    fs.rmSync(path.join(repo, 'CLAUDE.md'));
    expect(installClaudeRules(repo, 'v1')).toBe(true);
    expect(installClaudeRules(repo, 'v1')).toBe(false);
    expect(installClaudeRules(repo, 'v2')).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.claude', 'rules', 'devdeck.md'), 'utf8')).toBe('v2');
  });

  it('fasst Worktrees/Nicht-Repos nicht an', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(() => ensureGitExclude(plain, ['x'])).not.toThrow();
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
  });
});

describe('project.import (Agent → Server)', () => {
  let srv: TestServer;
  let cookie: string;
  let root: string;
  let ws: string;
  let projectId: string;
  let workspaceId: string;
  let config: AgentConfig;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-imp-'));
    ws = path.join(root, 'helferle');
    fs.mkdirSync(ws);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'helferle' } })).body.data.id;
    const m = await srv.enroll(cookie, 'helferle');
    workspaceId = (await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
      cookie, body: { machine_id: m.machineId, local_path: ws },
    })).body.data.id;
    config = {
      serverUrl: srv.base, machineId: m.machineId, machineToken: m.token, localToken: 'x',
      workspaceRoot: root, localPort: 0, agentVersion: 'test',
    };
    fs.writeFileSync(path.join(ws, 'CHANGELOG.md'), '## 1.0.0 - 2026-10-06\n### Added\n- Erster Release\n');
    fs.writeFileSync(path.join(ws, 'TODO.md'), '- [x] Fertig\n- [ ] Offen (P4)\n');
    fs.writeFileSync(path.join(ws, '.env'), 'MY_KEY=geheim-wert-1\n');
    fs.writeFileSync(path.join(ws, 'credentials.md'), '- OTHER_TOKEN: zwei-geheim\n');
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (payload: Record<string, unknown>) =>
    getAction('project.import')!({
      client: new ServerClient(config), config,
      payload: { local_path: ws, workspace_id: workspaceId, ...payload },
    });

  it('Vorschau schreibt nichts und enthält keine Werte; Apply importiert; zweiter Lauf ist idempotent', async () => {
    const preview = await run({ dry_run: true, environment: 'production' });
    expect(JSON.stringify(preview)).not.toContain('geheim');
    expect(preview).toMatchObject({
      dry_run: true,
      files: expect.arrayContaining(['CHANGELOG.md', 'TODO.md', '.env', 'credentials.md']),
      changelog: { new: 1 }, tasks: { new: 2, new_done: 1 }, secrets: { new: 2 },
    });
    expect((await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data).toHaveLength(0);

    const applied = await run({ dry_run: false, environment: 'production' });
    expect(applied).toMatchObject({ dry_run: false, changelog: { new: 1 }, secrets: { new: 2 } });
    expect(JSON.stringify(applied)).not.toContain('geheim');

    const secrets = (await srv.request('GET', `/api/projects/${projectId}/secrets`, { cookie })).body.data;
    expect(secrets.map((s: any) => `${s.name}:${s.environment}`).sort()).toEqual(['MY_KEY:production', 'OTHER_TOKEN:production']);
    const mine = secrets.find((s: any) => s.name === 'MY_KEY');
    expect((await srv.request('GET', `/api/projects/${projectId}/secrets/${mine.id}/values`, { cookie })).body.data.value).toBe('geheim-wert-1');
    const audits = JSON.stringify(srv.ctx.db.all('SELECT detail_json FROM audit_log'));
    expect(audits).not.toContain('geheim');

    const tasks = (await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data;
    expect(tasks.find((t: any) => t.title === 'Fertig')).toMatchObject({ status: 'done' });
    const log = (await srv.request('GET', `/api/projects/${projectId}/changelog`, { cookie })).body.data;
    expect(log[0].created_at.startsWith('2026-10-06')).toBe(true);

    const again = await run({ dry_run: false, environment: 'production' });
    expect(again).toMatchObject({ changelog: { new: 0 }, tasks: { new: 0 }, secrets: { new: 0, existing: 2 } });
    expect((await srv.request('GET', `/api/projects/${projectId}/secrets`, { cookie })).body.data).toHaveLength(2);
  });

  it('findet Dateien unabhängig von der Schreibweise (auch in docs/), fasst doppelte Secrets zusammen (.env gewinnt)', async () => {
    fs.rmSync(path.join(ws, 'CHANGELOG.md'));
    fs.rmSync(path.join(ws, 'TODO.md'));
    fs.mkdirSync(path.join(ws, 'docs'));
    fs.writeFileSync(path.join(ws, 'docs', 'Changelog.md'), '## 2026-10-20\n- Insta-Freigabe\n');
    fs.writeFileSync(path.join(ws, 'Roadmap.md'), '## Geplant\n- TikTok\n## Erledigt\n- Telegram ✅\n');
    fs.writeFileSync(path.join(ws, '.env'), 'GUI_PASS=aus-env\nONLY_ENV=a\n');
    fs.writeFileSync(path.join(ws, 'Credentials.md'), 'GUI_PASS: aus-doku\nONLY_DOC: b\n');
    fs.rmSync(path.join(ws, 'credentials.md'), { force: true });
    const preview = (await run({ dry_run: true, environment: 'production' })) as any;
    expect(preview.files).toEqual(expect.arrayContaining(['docs/Changelog.md', 'Roadmap.md', '.env', 'Credentials.md']));
    expect(preview).toMatchObject({ duplicates: 1, conflicts: 1, changelog: { new: 1 }, tasks: { new: 2, new_done: 1 }, secrets: { total: 3, new: 3 } });
    expect(preview.samples.tasks.map((t: any) => t.title)).toEqual(['TikTok', 'Telegram']);

    await run({ dry_run: false, environment: 'production' }); // darf nicht am Unique-Constraint scheitern
    const secrets = (await srv.request('GET', `/api/projects/${projectId}/secrets`, { cookie })).body.data;
    const gui = secrets.find((x: any) => x.name === 'GUI_PASS');
    expect((await srv.request('GET', `/api/projects/${projectId}/secrets/${gui.id}/values`, { cookie })).body.data.value).toBe('aus-env');
    expect(secrets).toHaveLength(3);
  });

  it('nennt bei fehlendem Changelog/Tasks die vorhandenen Textdateien (nur Namen)', async () => {
    fs.rmSync(path.join(ws, 'CHANGELOG.md'));
    fs.rmSync(path.join(ws, 'TODO.md'));
    fs.writeFileSync(path.join(ws, 'NOTIZEN.md'), 'irgendwas');
    const preview = (await run({ dry_run: true })) as any;
    expect(preview.files_seen).toEqual(expect.arrayContaining(['NOTIZEN.md']));
    expect(preview.changelog.total).toBe(0);
  });

  it('lehnt Pfade außerhalb des Roots und fremde Workspaces ab', async () => {
    await expect(run({ local_path: os.tmpdir() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await srv.enroll(cookie, 'andere');
    const otherCfg = { ...config, machineId: other.machineId, machineToken: other.token };
    await expect(
      getAction('project.import')!({
        client: new ServerClient(otherCfg), config: otherCfg,
        payload: { local_path: ws, workspace_id: workspaceId },
      }),
    ).rejects.toThrow(/anderen Maschine/);
  });

  it('lehnt den Import für zu alte Agents mit verständlicher Meldung ab (statt „Aktion nicht erlaubt“ vom Agent)', async () => {
    srv.ctx.db.run('UPDATE machines SET agent_version = ?', '0.3.0');
    const res = await srv.request('POST', `/api/workspaces/${workspaceId}/import`, { cookie, body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toContain('Version 0.3.0');
    expect(res.body.error?.message).toContain('Agent updaten');
    expect(srv.ctx.db.get(`SELECT 1 FROM agent_commands WHERE action = 'project.import'`)).toBeUndefined();
  });

  it('UI-Routen: Import beauftragen und Ergebnis abrufen (nur Maintainer)', async () => {
    srv.ctx.db.run('UPDATE machines SET agent_version = ?', '0.4.0');
    const res = await srv.request('POST', `/api/workspaces/${workspaceId}/import`, { cookie, body: { environment: 'staging' } });
    expect(res.status).toBe(202);
    const cmd = srv.ctx.db.get<{ action: string; payload_json: string }>('SELECT action, payload_json FROM agent_commands WHERE id = ?', res.body.data.command_id)!;
    expect(cmd.action).toBe('project.import');
    expect(JSON.parse(cmd.payload_json)).toMatchObject({ dry_run: true, environment: 'staging', workspace_id: workspaceId });
    const status = await srv.request('GET', `/api/workspaces/${workspaceId}/commands/${res.body.data.command_id}`, { cookie });
    expect(status.body.data).toMatchObject({ status: 'queued', result: null });
    expect((await srv.request('POST', `/api/workspaces/${workspaceId}/import`, { cookie, body: { environment: 'x' } })).status).toBe(400);
  });
});
