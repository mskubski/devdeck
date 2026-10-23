import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerClient } from '../src/client.js';
import type { AgentConfig } from '../src/config.js';
import { encodeProjectPath, scanAndReport, scanWorkspace, summarizeTranscript } from '../src/sessionScanner.js';
import { startTestServer, TEST_ADMIN, type TestServer } from '../../server/test/helpers.js';

const SECRET_PROMPT = 'Bitte nutze das Passwort hunter2 für die DB';

function transcript(cwd: string, opts: { title?: string; branch?: string; start: string; end: string; pr?: string }): string {
  const lines: unknown[] = [
    { type: 'user', cwd, gitBranch: opts.branch ?? 'main', timestamp: opts.start, entrypoint: 'cli', message: { content: SECRET_PROMPT } },
    { type: 'assistant', cwd, timestamp: opts.start, message: { content: 'ok' } },
    { type: 'user', isSidechain: true, cwd, timestamp: '2020-01-01T00:00:00Z', message: { content: 'sub' } },
  ];
  if (opts.title) lines.push({ type: 'ai-title', aiTitle: 'Alter Titel' }, { type: 'ai-title', aiTitle: opts.title });
  if (opts.pr) lines.push({ type: 'pr-link', prUrl: opts.pr });
  lines.push({ type: 'assistant', cwd, timestamp: opts.end, message: { content: 'fertig' } });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"user","cwd":"abgeschnit`;
}

describe('Claude-Code-Session-Scanner (Agent)', () => {
  let tmp: string;
  let claude: string;
  let workspace: string;

  const write = (folderPath: string, id: string, content: string): void => {
    const dir = path.join(claude, 'projects', encodeProjectPath(folderPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), content);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-scan-'));
    claude = path.join(tmp, 'claude');
    workspace = path.join(tmp, 'Development', 'my.app');
    fs.mkdirSync(workspace, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('kodiert Pfade wie Claude Code', () => {
    expect(encodeProjectPath('/home/mskubski/Development/devdeck')).toBe('-home-mskubski-Development-devdeck');
    expect(encodeProjectPath('C:\\Users\\me\\my.app')).toBe('C--Users-me-my-app');
  });

  it('fasst ein Transcript zusammen: letzter Titel, Branch, PR, ohne Sidechains, tolerant bei halber Zeile', () => {
    write(workspace, 's1', transcript(workspace, { title: 'Login-Bug fixen', branch: 'fix/login', start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:30:00Z', pr: 'https://github.com/a/b/pull/9' }));
    const s = summarizeTranscript(path.join(claude, 'projects', encodeProjectPath(workspace), 's1.jsonl'))!;
    expect(s).toMatchObject({
      external_id: 's1', title: 'Login-Bug fixen', git_branch: 'fix/login', pr_url: 'https://github.com/a/b/pull/9',
      message_count: 3, entrypoint: 'cli', started_at: '2026-10-20T10:00:00.000Z', last_activity_at: '2026-10-20T11:30:00.000Z',
    });
    expect(JSON.stringify(s)).not.toContain('hunter2');
  });

  it('findet Sessions im Workspace und in Unterordnern, aber nicht in Nachbarprojekten', () => {
    const sub = path.join(workspace, 'packages', 'x');
    const sibling = `${workspace}-other`;
    fs.mkdirSync(sub, { recursive: true });
    write(workspace, 'a', transcript(workspace, { start: '2026-10-01T10:00:00Z', end: '2026-10-01T10:05:00Z' }));
    write(sub, 'b', transcript(sub, { start: '2026-10-02T10:00:00Z', end: '2026-10-02T10:05:00Z' }));
    write(sibling, 'c', transcript(sibling, { start: '2026-10-03T10:00:00Z', end: '2026-10-03T10:05:00Z' }));
    const found = scanWorkspace(workspace, claude).map((s) => s.external_id).sort();
    expect(found).toEqual(['a', 'b']);
    expect(scanWorkspace(path.join(tmp, 'gibt-es-nicht'), claude)).toEqual([]);
  });

  describe('Meldung an den Server', () => {
    let srv: TestServer;
    let cookie: string;
    let client: ServerClient;
    let projectId: string;

    beforeEach(async () => {
      srv = await startTestServer();
      cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
      projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
      const machine = await srv.enroll(cookie);
      await srv.request('POST', `/api/projects/${projectId}/workspaces`, {
        cookie, body: { machine_id: machine.machineId, local_path: workspace },
      });
      const config: AgentConfig = {
        serverUrl: srv.base, machineId: machine.machineId, machineToken: machine.token, localToken: 'x',
        workspaceRoot: tmp, localPort: 0, agentVersion: '0.0.0',
      };
      client = new ServerClient(config);
    });
    afterEach(async () => {
      await srv.close();
    });

    const sessions = async () => (await srv.request('GET', `/api/projects/${projectId}/sessions`, { cookie })).body.data;

    it('importiert idempotent, ohne Prompt-Inhalte, mit offen/beendet-Status', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      write(workspace, 'old', transcript(workspace, { title: 'Alte Session', branch: 'main', start: '2026-10-01T10:00:00Z', end: '2026-10-01T12:00:00Z' }));
      write(workspace, 'live', transcript(workspace, { title: 'Laufende Session', start: recent, end: recent }));
      const seen = new Map<string, string>();

      const first = await scanAndReport(client, claude, seen);
      expect(first).toEqual({ workspaces: 1, sent: 2 });
      const list = await sessions();
      expect(list).toHaveLength(2);
      const old = list.find((s: any) => s.goal === 'Alte Session');
      expect(old).toMatchObject({ status: 'closed', source: 'claude-code', git_branch: 'main', message_count: 3, ended_at: '2026-10-01T12:00:00.000Z' });
      expect(list.find((s: any) => s.goal === 'Laufende Session').status).toBe('open');
      expect(JSON.stringify(srv.ctx.db.all('SELECT * FROM coding_sessions'))).not.toContain('hunter2');

      // unverändert → nichts gesendet; geänderte Datei → Update statt Duplikat
      expect((await scanAndReport(client, claude, seen)).sent).toBe(0);
      write(workspace, 'live', transcript(workspace, { title: 'Umbenannt', start: recent, end: '2026-10-21T09:00:00Z' }));
      expect((await scanAndReport(client, claude, seen)).sent).toBe(1);
      const after = await sessions();
      expect(after).toHaveLength(2);
      expect(after.find((s: any) => s.goal === 'Umbenannt').status).toBe('closed');
    });

    it('Import ignoriert fremde Workspaces und ungültige Einträge', async () => {
      const res = await client.request('POST', '/api/agent/sessions/import', {
        body: { sessions: [
          { workspace_id: 'fremd', external_id: 'x', started_at: '2026-10-01T10:00:00Z' },
          { external_id: 'y' },
        ] },
      });
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ created: 0, updated: 0, skipped: 2 });
      expect((await client.request('POST', '/api/agent/sessions/import', { body: {} })).status).toBe(400);
    });
  });
});
