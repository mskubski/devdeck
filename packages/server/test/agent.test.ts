import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueCommand, sweepExpiredCommands, sweepOfflineAgents } from '../src/services/provisioning.js';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('Phase B: Agent-Protokoll', () => {
  let srv: TestServer;
  let cookie: string;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
  });
  afterEach(async () => {
    await srv.close();
  });

  describe('Machine Enrollment', () => {
    it('schreibt Maschine bei gültigem Token an und liefert Maschinen-Token', async () => {
      const { machineId, token } = await srv.enroll(cookie, 'Alice-PC');
      expect(machineId).toBeTruthy();
      expect(token.length).toBeGreaterThan(20);

      const machine = srv.ctx.db.get<{ name: string; agent_status: string; token_hash: string }>(
        'SELECT name, agent_status, token_hash FROM machines WHERE id = ?',
        machineId,
      );
      expect(machine?.name).toBe('Alice-PC');
      expect(machine?.agent_status).toBe('online');
      // Token wird nur gehasht gespeichert
      expect(machine?.token_hash).not.toBe(token);

      const audits = srv.ctx.db.all<{ result: string }>(
        `SELECT result FROM audit_log WHERE action = 'machine.enroll'`,
      );
      expect(audits.some((a) => a.result === 'success')).toBe(true);
    });

    it('erlaubt Enrollment-Token nur einmal', async () => {
      const tokenRes = await srv.request('POST', '/api/machines/enrollment-tokens', {
        cookie,
        body: {},
      });
      expect(tokenRes.status).toBe(201);
      const raw = tokenRes.body.data.token;

      const first = await srv.request('POST', '/api/agent/enroll', {
        body: { enrollment_token: raw, name: 'Machine-1' },
      });
      expect(first.status).toBe(201);

      const second = await srv.request('POST', '/api/agent/enroll', {
        body: { enrollment_token: raw, name: 'Machine-2' },
      });
      expect(second.status).toBe(401);
      expect(second.body.error.message).toContain('verwendet');
    });

    it('lehnt abgelaufene, widerrufene und unbekannte Tokens ab', async () => {
      // abgelaufen
      const expired = await srv.request('POST', '/api/machines/enrollment-tokens', {
        cookie,
        body: { ttl_minutes: 60 },
      });
      srv.ctx.db.run('UPDATE enrollment_tokens SET expires_at = ? WHERE id = ?', 
        new Date(Date.now() - 1000).toISOString(), expired.body.data.id);
      const resExpired = await srv.request('POST', '/api/agent/enroll', {
        body: { enrollment_token: expired.body.data.token, name: 'X' },
      });
      expect(resExpired.status).toBe(401);
      expect(resExpired.body.error.message).toContain('abgelaufen');

      // widerrufen
      const revoked = await srv.request('POST', '/api/machines/enrollment-tokens', {
        cookie,
        body: {},
      });
      srv.ctx.db.run('UPDATE enrollment_tokens SET revoked_at = ? WHERE id = ?',
        new Date().toISOString(), revoked.body.data.id);
      const resRevoked = await srv.request('POST', '/api/agent/enroll', {
        body: { enrollment_token: revoked.body.data.token, name: 'X' },
      });
      expect(resRevoked.status).toBe(401);

      // unbekannt
      const resUnknown = await srv.request('POST', '/api/agent/enroll', {
        body: { enrollment_token: 'unsinniges-token', name: 'X' },
      });
      expect(resUnknown.status).toBe(401);

      const denied = srv.ctx.db.all<{ result: string }>(
        `SELECT result FROM audit_log WHERE action = 'machine.enroll' AND result = 'denied'`,
      );
      expect(denied.length).toBe(3);
    });

    it('verweigert Nicht-Mitgliedern das Erzeugen von Enrollment-Tokens', async () => {
      const project = await srv.request('POST', '/api/projects', {
        cookie,
        body: { name: 'MobileApp' },
      });
      await srv.request('POST', '/api/users', {
        cookie,
        body: { email: 'fremd@devdeck.test', password: 'fremd-pass-123' },
      });
      const foreign = await srv.login('fremd@devdeck.test', 'fremd-pass-123');
      const res = await srv.request('POST', '/api/machines/enrollment-tokens', {
        cookie: foreign,
        body: { project_id: project.body.data.id },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('Agent-Authentifizierung & Heartbeat', () => {
    it('verlangt für Heartbeat ein gültiges Maschinen-Token', async () => {
      const noAuth = await srv.request('POST', '/api/agent/heartbeat', { body: {} });
      expect(noAuth.status).toBe(401);

      const badAuth = await srv.request('POST', '/api/agent/heartbeat', {
        token: 'bla-tok',
        body: {},
      });
      expect(badAuth.status).toBe(401);
    });

    it('aktualisiert last_seen_at und Agent-Version per Heartbeat', async () => {
      const { token } = await srv.enroll(cookie, 'Bob-Laptop');
      const res = await srv.request('POST', '/api/agent/heartbeat', {
        token,
        body: { agent_version: '0.1.0', platform: 'linux' },
      });
      expect(res.status).toBe(200);
      const machine = srv.ctx.db.get<{ last_seen_at: string; agent_status: string }>(
        'SELECT last_seen_at, agent_status FROM machines WHERE token_hash IS NOT NULL',
      );
      expect(machine?.last_seen_at).toBeTruthy();
      expect(machine?.agent_status).toBe('online');
    });

    it('registriert Workspaces aus dem Heartbeat projektbezogen', async () => {
      const project = await srv.request('POST', '/api/projects', {
        cookie,
        body: { name: 'WebApp' },
      });
      const slug = project.body.data.slug;
      const { token } = await srv.enroll(cookie, 'Alice-PC');
      const res = await srv.request('POST', '/api/agent/heartbeat', {
        token,
        body: {
          agent_version: '0.1.0',
          workspaces: [
            { local_path: '/home/m/Development/WebApp', project: slug, branch: 'main' },
            { local_path: '/tmp/ohne-projekt' },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.workspaces).toBe(1);
      const rows = srv.ctx.db.all<{ local_path: string; branch: string }>(
        'SELECT local_path, branch FROM workspaces',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.local_path).toBe('/home/m/Development/WebApp');
      expect(rows[0]!.branch).toBe('main');
    });

    it('lehnt widerrufene Maschinen ab', async () => {
      const { machineId, token } = await srv.enroll(cookie, 'Widerruf-Machine');
      const revoke = await srv.request('DELETE', `/api/machines/${machineId}`, {
        cookie,
        body: { confirm: true },
      });
      expect(revoke.status).toBe(200);

      const after = await srv.request('POST', '/api/agent/heartbeat', { token, body: {} });
      expect(after.status).toBe(401);
      expect(after.body.error.message).toContain('widerrufen');
    });

    it('erzwingt confirm beim Maschinen-Widerruf', async () => {
      const { machineId } = await srv.enroll(cookie, 'Safe-Machine');
      const res = await srv.request('DELETE', `/api/machines/${machineId}`, { cookie, body: {} });
      expect(res.status).toBe(428);
      expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('markiert Maschinen ohne Heartbeat als offline (Sweep)', async () => {
      const { machineId } = await srv.enroll(cookie, 'Schlaf-Machine');
      srv.ctx.db.run('UPDATE machines SET last_seen_at = ? WHERE id = ?',
        new Date(Date.now() - 10 * 60_000).toISOString(), machineId);
      const changed = sweepOfflineAgents(srv.ctx.db);
      expect(changed).toBeGreaterThanOrEqual(1);
      const row = srv.ctx.db.get<{ agent_status: string }>(
        'SELECT agent_status FROM machines WHERE id = ?',
        machineId,
      );
      expect(row?.agent_status).toBe('offline');
    });
  });

  describe('Command-Queue (Long-Poll)', () => {
    it('liefert ausstehende Commands und speichert Resultate idempotent', async () => {
      const { machineId, token } = await srv.enroll(cookie, 'Worker-Machine');
      const commandId = enqueueCommand(srv.ctx.db, {
        machineId,
        action: 'workspace.status',
        payload: { workspace_id: 'ws-1' },
      });

      const poll = await srv.request('GET', '/api/agent/commands?wait=1', { token });
      expect(poll.status).toBe(200);
      expect(poll.body.data).toHaveLength(1);
      expect(poll.body.data[0].id).toBe(commandId);
      expect(poll.body.data[0].action).toBe('workspace.status');
      expect(poll.body.data[0].payload.workspace_id).toBe('ws-1');

      const done = await srv.request('POST', `/api/agent/commands/${commandId}/result`, {
        token,
        body: { status: 'done', data: { overall: 'READY' } },
      });
      expect(done.status).toBe(200);
      expect(done.body.data.first_report).toBe(true);

      const again = await srv.request('POST', `/api/agent/commands/${commandId}/result`, {
        token,
        body: { status: 'failed' },
      });
      expect(again.status).toBe(200);
      expect(again.body.data.first_report).toBe(false);

      const row = srv.ctx.db.get<{ status: string; result_json: string }>(
        'SELECT status, result_json FROM agent_commands WHERE id = ?',
        commandId,
      );
      expect(row?.status).toBe('done');
      expect(row?.result_json).toContain('READY');
    });

    it('gibt 204 zurück, wenn kein Command aussteht', async () => {
      const { token } = await srv.enroll(cookie, 'Leer-Machine');
      const res = await srv.request('GET', '/api/agent/commands?wait=0', { token });
      expect(res.status).toBe(204);
    });

    it('lässt fremde Maschinen keine Commands annehmen', async () => {
      const a = await srv.enroll(cookie, 'Machine-A');
      const b = await srv.enroll(cookie, 'Machine-B');
      const commandId = enqueueCommand(srv.ctx.db, {
        machineId: a.machineId,
        action: 'workspace.status',
      });
      const res = await srv.request('POST', `/api/agent/commands/${commandId}/result`, {
        token: b.token,
        body: { status: 'done' },
      });
      expect(res.status).toBe(404);
    });

    it('markiert abgelaufene Commands als expired', async () => {
      const { machineId } = await srv.enroll(cookie, 'Ablauf-Machine');
      const commandId = enqueueCommand(srv.ctx.db, {
        machineId,
        action: 'context.refresh',
        ttlSeconds: 60,
      });
      srv.ctx.db.run(
        'UPDATE agent_commands SET expires_at = ? WHERE id = ?',
        new Date(Date.now() - 1000).toISOString(),
        commandId,
      );
      const swept = sweepExpiredCommands(srv.ctx.db);
      expect(swept).toBeGreaterThanOrEqual(1);
      const row = srv.ctx.db.get<{ status: string }>(
        'SELECT status FROM agent_commands WHERE id = ?',
        commandId,
      );
      expect(row?.status).toBe('expired');
    });

    it('lässt Widerruf ausstehende Commands sofort beenden', async () => {
      const { machineId, token } = await srv.enroll(cookie, 'Rev-Machine');
      const commandId = enqueueCommand(srv.ctx.db, { machineId, action: 'workspace.sync' });
      await srv.request('DELETE', `/api/machines/${machineId}`, {
        cookie,
        body: { confirm: true },
      });
      const row = srv.ctx.db.get<{ status: string }>(
        'SELECT status FROM agent_commands WHERE id = ?',
        commandId,
      );
      expect(row?.status).toBe('expired');
      const poll = await srv.request('GET', '/api/agent/commands?wait=0', { token });
      expect(poll.status).toBe(401);
    });
  });

  describe('Workspace-Status-Report', () => {
    it('aktualisiert Workspace-Status und Git-Metadaten', async () => {
      const project = await srv.request('POST', '/api/projects', {
        cookie,
        body: { name: 'WebApp' },
      });
      const { token } = await srv.enroll(cookie, 'Status-Machine');
      await srv.request('POST', '/api/agent/heartbeat', {
        token,
        body: {
          workspaces: [
            { local_path: '/root/Development/WebApp', project: project.body.data.slug },
          ],
        },
      });
      const ws = srv.ctx.db.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1');
      expect(ws).toBeTruthy();

      const res = await srv.request('POST', `/api/agent/workspaces/${ws!.id}/status`, {
        token,
        body: {
          git: { branch: 'main', commit: 'abc123', dirty: false, message: 'Init' },
          readiness: { overall: 'READY', checks: [] },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ready');

      const updated = srv.ctx.db.get<{ status: string; last_git_commit: string }>(
        'SELECT status, last_git_commit FROM workspaces WHERE id = ?',
        ws!.id,
      );
      expect(updated?.status).toBe('ready');
      expect(updated?.last_git_commit).toBe('abc123');

      const gitRows = srv.ctx.db.all('SELECT id FROM git_metadata WHERE commit_sha = ?', 'abc123');
      expect(gitRows).toHaveLength(1);
    });

    it('verbietet Status-Meldungen für Workspaces anderer Maschinen', async () => {
      const project = await srv.request('POST', '/api/projects', {
        cookie,
        body: { name: 'MobileApp' },
      });
      const a = await srv.enroll(cookie, 'Maschine-A');
      await srv.request('POST', '/api/agent/heartbeat', {
        token: a.token,
        body: {
          workspaces: [
            { local_path: '/root/Development/MobileApp', project: project.body.data.slug },
          ],
        },
      });
      const ws = srv.ctx.db.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1');
      const b = await srv.enroll(cookie, 'Maschine-B');
      const res = await srv.request('POST', `/api/agent/workspaces/${ws!.id}/status`, {
        token: b.token,
        body: { readiness: { overall: 'READY', checks: [] } },
      });
      expect(res.status).toBe(403);
    });
  });
});
