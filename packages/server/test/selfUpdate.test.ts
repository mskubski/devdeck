import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { runAutoUpdateTick } from '../src/services/autoUpdate.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BUILD_OK = `require('fs').writeFileSync('built.txt', 'v' + require('./version.json').v)`;

/** Echte Git-Repos: bare Remote + "Produktiv"-Checkout (repoRoot) + zweiter Klon zum Veröffentlichen. */
describe('System-Update per Knopfdruck', () => {
  let tmp: string;
  let prod: string;
  let dev: string;
  let srv: TestServer;
  let cookie: string;
  let restarts: number;

  const publish = (version: number, build = BUILD_OK): void => {
    fs.writeFileSync(path.join(dev, 'version.json'), JSON.stringify({ v: version }));
    const pkg = JSON.parse(fs.readFileSync(path.join(dev, 'package.json'), 'utf8'));
    pkg.scripts.build = `node -e "${build.replace(/"/g, '\\"')}"`;
    fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify(pkg));
    git(dev, 'add', '-A');
    git(dev, 'commit', '-m', `v${version}`);
    git(dev, 'push', 'origin', 'main');
  };

  const waitDone = async (): Promise<any> => {
    for (let i = 0; i < 200; i++) {
      const s = (await srv.request('GET', '/api/system/update', { cookie })).body.data;
      if (s.state !== 'running') return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Update hängt');
  };
  const trigger = async (): Promise<any> => {
    const res = await srv.request('POST', '/api/system/update', { cookie });
    expect(res.status).toBe(202);
    return waitDone();
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-upd-'));
    const bare = path.join(tmp, 'origin.git');
    dev = path.join(tmp, 'dev');
    prod = path.join(tmp, 'prod');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['clone', bare, dev], { stdio: 'ignore' });
    git(dev, 'config', 'user.email', 't@t.de');
    git(dev, 'config', 'user.name', 'T');
    git(dev, 'checkout', '-b', 'main');
    fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { build: 'true' } }));
    execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: dev, stdio: 'ignore' });
    publish(1);
    execFileSync('git', ['clone', bare, prod], { stdio: 'ignore' });
    git(prod, 'config', 'user.email', 't@t.de');
    git(prod, 'config', 'user.name', 'T');

    restarts = 0;
    srv = await startTestServer({ DEVDECK_REPO_ROOT: prod, DEVDECK_UPDATE_BRANCH: 'main' });
    srv.ctx.restart = () => { restarts++; };
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('zeigt Version und verfügbare Updates; nur für Admins', async () => {
    expect((await srv.request('GET', '/api/system/version')).status).toBe(401);
    let v = (await srv.request('GET', '/api/system/version?refresh=1', { cookie })).body.data;
    expect(v).toMatchObject({ branch: 'main', subject: 'v1', behind: 0, dirty: false, on_other_branch: false });
    publish(2);
    v = (await srv.request('GET', '/api/system/version?refresh=1', { cookie })).body.data;
    expect(v.behind).toBe(1);
  });

  it('aktualisiert: Backup, Fast-Forward, npm ci, Build, Neustart', async () => {
    publish(2);
    const done = await trigger();
    expect(done.state).toBe('success');
    expect(done.restarting).toBe(true);
    expect(done.steps.map((s: any) => s.name)).toEqual([
      'Zustand prüfen', 'Von GitHub laden', 'Datensicherung', 'Code aktualisieren',
      'Abhängigkeiten installieren', 'Bauen', 'Agents aktualisieren', 'Neustart',
    ]);
    expect(fs.readFileSync(path.join(prod, 'built.txt'), 'utf8')).toBe('v2');
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('v2');
    expect(restarts).toBe(1);
    const backups = (await srv.request('GET', '/api/backups', { cookie })).body.data.backups;
    expect(backups.some((b: any) => b.status === 'success')).toBe(true);
    const audits = srv.ctx.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'system.update%'`);
    expect(audits.map((a) => a.action)).toEqual(['system.update.start', 'system.update.agents', 'system.update.finish']);
  });

  it('meldet "bereits aktuell" ohne Neustart', async () => {
    const done = await trigger();
    expect(done.state).toBe('success');
    expect(done.restarting).toBe(false);
    expect(restarts).toBe(0);
  });

  it('bricht bei lokalen Änderungen ab und fasst nichts an', async () => {
    publish(2);
    fs.appendFileSync(path.join(prod, 'package.json'), ' ');
    const done = await trigger();
    expect(done.state).toBe('failed');
    expect(done.error).toContain('lokale Änderungen');
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('v1');
    expect(restarts).toBe(0);
  });

  it('wechselt von einem anderen Branch auf main', async () => {
    git(prod, 'checkout', '-b', 'feature/alt');
    publish(2);
    const done = await trigger();
    expect(done.state).toBe('success');
    expect(git(prod, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('v2');
  });

  it('setzt bei fehlgeschlagenem Build auf den vorherigen Stand zurück und startet nicht neu', async () => {
    publish(2, 'process.exit(3)');
    const done = await trigger();
    expect(done.state).toBe('failed');
    expect(done.error).toContain('npm run build');
    expect(done.steps.some((s: any) => s.name.startsWith('Zurücksetzen'))).toBe(true);
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('v1');
    expect(restarts).toBe(0);
  });

  describe('Agents mit aktualisieren', () => {
    const addMachine = async (name: string, version: string, status = 'online'): Promise<string> => {
      const m = await srv.enroll(cookie, name);
      srv.ctx.db.run('UPDATE machines SET agent_version = ?, agent_status = ? WHERE id = ?', version, status, m.machineId);
      return m.machineId;
    };
    const queued = () =>
      srv.ctx.db.all<{ machine_id: string; action: string }>(`SELECT machine_id, action FROM agent_commands WHERE action = 'agent.update'`);

    it('reiht agent.update für online-Agents ein, überspringt zu alte und offline-Maschinen', async () => {
      const fresh = await addMachine('neu', '0.3.0');
      await addMachine('alt', '0.1.0');
      await addMachine('aus', '0.3.0', 'offline');
      publish(2);
      const done = await trigger();
      expect(done.state).toBe('success');
      expect(queued()).toEqual([{ machine_id: fresh, action: 'agent.update' }]);
      const step = done.steps.find((s: any) => s.name === 'Agents aktualisieren');
      expect(step.detail).toContain('1 beauftragt');
      expect(step.detail).toContain('alt');
      expect(done.steps.map((s: any) => s.name).indexOf('Agents aktualisieren')).toBeLessThan(done.steps.length - 1);
    });

    it('auch bei bereits aktuellem Server; agents:false lässt Agents in Ruhe', async () => {
      const fresh = await addMachine('neu', '0.3.0');
      let res = await srv.request('POST', '/api/system/update', { cookie, body: { agents: false } });
      expect(res.status).toBe(202);
      await waitDone();
      expect(queued()).toEqual([]);
      res = await srv.request('POST', '/api/system/update', { cookie, body: {} });
      await waitDone();
      expect(queued().map((q) => q.machine_id)).toEqual([fresh]);
    });
  });

  describe('Einstellungen und automatisches Update', () => {
    const hourNow = () => new Date().getHours();

    it('speichert Einstellungen, validiert und merkt das Ergebnis des letzten Updates', async () => {
      let s = (await srv.request('GET', '/api/system/settings', { cookie })).body.data;
      expect(s).toMatchObject({ auto_update_enabled: false, auto_update_hour: 3, last_update: null });
      expect((await srv.request('PUT', '/api/system/settings', { cookie, body: { auto_update_hour: 25 } })).status).toBe(400);
      expect((await srv.request('PUT', '/api/system/settings', { cookie, body: { auto_update_enabled: true, auto_update_hour: 4 } })).status).toBe(200);
      publish(2);
      await trigger();
      s = (await srv.request('GET', '/api/system/settings', { cookie })).body.data;
      expect(s).toMatchObject({ auto_update_enabled: true, auto_update_hour: 4 });
      expect(s.last_update).toMatchObject({ result: 'success', by: TEST_ADMIN.email });
    });

    it('tick: nur wenn aktiviert, richtige Stunde, höchstens einmal pro Tag', async () => {
      expect(await runAutoUpdateTick(srv.ctx)).toBe('disabled');
      await srv.request('PUT', '/api/system/settings', { cookie, body: { auto_update_enabled: true, auto_update_hour: (hourNow() + 1) % 24 } });
      expect(await runAutoUpdateTick(srv.ctx)).toBe('wrong_hour');
      await srv.request('PUT', '/api/system/settings', { cookie, body: { auto_update_hour: hourNow() } });

      expect(await runAutoUpdateTick(srv.ctx)).toBe('up_to_date');
      expect(await runAutoUpdateTick(srv.ctx)).toBe('already_checked');
      expect(restarts).toBe(0);

      srv.ctx.db.run(`DELETE FROM settings WHERE key = 'auto_update_last_check'`);
      publish(2);
      expect(await runAutoUpdateTick(srv.ctx)).toBe('started');
      const done = await waitDone();
      expect(done.state).toBe('success');
      expect(git(prod, 'log', '-1', '--format=%s')).toBe('v2');
      expect(restarts).toBe(1);
      const audits = srv.ctx.db.all<{ actor_type: string }>(`SELECT actor_type FROM audit_log WHERE action = 'system.update.start'`);
      expect(audits[0]!.actor_type).toBe('system');
      expect(await runAutoUpdateTick(srv.ctx)).toBe('already_checked');
    });

    it('tick: überspringt bei lokalen Änderungen und vermerkt es', async () => {
      await srv.request('PUT', '/api/system/settings', { cookie, body: { auto_update_enabled: true, auto_update_hour: hourNow() } });
      publish(2);
      fs.appendFileSync(path.join(prod, 'package.json'), ' ');
      expect(await runAutoUpdateTick(srv.ctx)).toBe('skipped_dirty');
      expect(git(prod, 'log', '-1', '--format=%s')).toBe('v1');
      const s = (await srv.request('GET', '/api/system/settings', { cookie })).body.data;
      expect(s.last_update).toMatchObject({ result: 'failed', by: 'automatisch' });
    });

    it('tick: wartet, solange ein Agent-Auftrag läuft', async () => {
      await srv.request('PUT', '/api/system/settings', { cookie, body: { auto_update_enabled: true, auto_update_hour: hourNow() } });
      const m = await srv.enroll(cookie, 'busy');
      srv.ctx.db.run(
        `INSERT INTO agent_commands (id, machine_id, action, payload_json, status, created_at) VALUES ('c1', ?, 'workspace.sync', '{}', 'running', ?)`,
        m.machineId,
        new Date().toISOString(),
      );
      expect(await runAutoUpdateTick(srv.ctx)).toBe('busy');
    });
  });
});
