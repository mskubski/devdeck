import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

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
      'Abhängigkeiten installieren', 'Bauen', 'Neustart',
    ]);
    expect(fs.readFileSync(path.join(prod, 'built.txt'), 'utf8')).toBe('v2');
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('v2');
    expect(restarts).toBe(1);
    const backups = (await srv.request('GET', '/api/backups', { cookie })).body.data.backups;
    expect(backups.some((b: any) => b.status === 'success')).toBe(true);
    const audits = srv.ctx.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'system.update%'`);
    expect(audits.map((a) => a.action)).toEqual(['system.update.start', 'system.update.finish']);
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
});
