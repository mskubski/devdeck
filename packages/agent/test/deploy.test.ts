import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDeploy, type CmdResult, type DeployDeps } from '../src/deploy.js';
import { parseManifest } from '../src/manifest.js';

const MANIFEST = `version: 1
project:
  name: Helferle
deploy:
  timeout_seconds: 5
  install: .venv/bin/pip install -r requirements.txt
  services:
    - unit: helferle-api
      health_url: http://localhost:5001/v1/health
    - unit: helferle
`;

describe('Manifest: deploy-Block', () => {
  const base = 'version: 1\nproject:\n  name: X\n';
  it('liest Dienste, Install-Befehl und Zeitlimit', () => {
    const m = parseManifest(MANIFEST);
    expect(m.deploy?.services).toEqual([
      { unit: 'helferle-api', health_url: 'http://localhost:5001/v1/health' },
      { unit: 'helferle' },
    ]);
    expect(m.deploy?.install).toBe('.venv/bin/pip install -r requirements.txt');
    expect(m.deploy?.timeout_seconds).toBe(5);
  });
  it('akzeptiert Kurzform und setzt Standard-Zeitlimit', () => {
    expect(parseManifest(`${base}deploy:\n  services: [helferle]\n`).deploy).toEqual({ services: [{ unit: 'helferle' }], timeout_seconds: 60 });
  });
  it('lehnt ungültige Unit-Namen ab', () => {
    expect(() => parseManifest(`${base}deploy:\n  services: ["a; rm -rf /"]\n`)).toThrowError(/Unit-Name/);
    expect(() => parseManifest(`${base}deploy:\n  services: ["--now"]\n`)).toThrowError(/Unit-Name/);
  });
  it('lehnt Health-URLs außerhalb von localhost ab', () => {
    expect(() => parseManifest(`${base}deploy:\n  services:\n    - unit: a\n      health_url: http://169.254.169.254/\n`)).toThrowError(/localhost/);
  });
  it('lehnt Shell-Metazeichen im Install-Befehl ab', () => {
    expect(() => parseManifest(`${base}deploy:\n  install: "pip install x; id"\n  services: [a]\n`)).toThrowError(/unzulässige Zeichen/);
  });
  it('verlangt mindestens einen Dienst', () => {
    expect(() => parseManifest(`${base}deploy:\n  services: []\n`)).toThrowError(/services/);
  });
});

describe('runDeploy', () => {
  let dir: string;
  let origin: string;
  let work: string;
  let upstream: string;
  let calls: string[];
  let healthy: boolean;
  let installCode: number;

  const read = (f: string): string => fs.readFileSync(path.join(work, f), 'utf8').split('\r\n').join('\n');
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const deps = (): DeployDeps => ({
    async systemctl(args): Promise<CmdResult> {
      calls.push(`systemctl ${args.join(' ')}`);
      if (args[0] === 'is-active') return { code: 0, output: 'active' };
      return { code: 0, output: '' };
    },
    async run(_cwd, command): Promise<CmdResult> {
      calls.push(`run ${command}`);
      return { code: installCode, output: installCode ? 'pip kaputt' : '' };
    },
    async httpOk(url): Promise<boolean> {
      calls.push(`http ${url}`);
      return healthy;
    },
    sleep: async () => undefined,
  });

  const push = (file: string, content: string): void => {
    fs.writeFileSync(path.join(upstream, file), content);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', `change ${file}`);
    git(upstream, 'push', 'origin', 'main');
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-deploy-'));
    origin = path.join(dir, 'origin.git');
    upstream = path.join(dir, 'upstream');
    work = path.join(dir, 'work');
    calls = [];
    healthy = true;
    installCode = 0;
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-b', 'main');
    git(upstream, 'config', 'user.email', 't@test.de');
    git(upstream, 'config', 'user.name', 'Test');
    fs.mkdirSync(path.join(upstream, '.devdeck'));
    fs.writeFileSync(path.join(upstream, '.devdeck', 'workspace.yaml'), MANIFEST);
    fs.writeFileSync(path.join(upstream, 'app.py'), 'v1\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'init');
    git(upstream, 'remote', 'add', 'origin', origin);
    git(upstream, 'push', '-u', 'origin', 'main');
    execFileSync('git', ['clone', origin, work]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('holt neuen Code, installiert, startet neu und prüft', async () => {
    push('app.py', 'v2\n');
    const out = await runDeploy(work, 'main', deps());
    expect(out.up_to_date).toBe(false);
    expect(read('app.py')).toBe('v2\n');
    expect(calls).toEqual([
      'run .venv/bin/pip install -r requirements.txt',
      'systemctl restart helferle-api',
      'systemctl restart helferle',
      'http http://localhost:5001/v1/health',
      'systemctl is-active helferle',
    ]);
    expect(out.steps.every((s) => s.status !== 'failed')).toBe(true);
  });

  it('startet auch ohne neuen Code neu, installiert dann aber nicht', async () => {
    const out = await runDeploy(work, 'main', deps());
    expect(out.up_to_date).toBe(true);
    expect(calls).not.toContain('run .venv/bin/pip install -r requirements.txt');
    expect(calls).toContain('systemctl restart helferle-api');
  });

  it('bricht bei lokalen Änderungen ab, ohne etwas zu verändern', async () => {
    push('app.py', 'v2\n');
    fs.writeFileSync(path.join(work, 'app.py'), 'lokal\n');
    await expect(runDeploy(work, 'main', deps())).rejects.toMatchObject({ code: 'GIT_DIRTY', message: expect.stringContaining('app.py') });
    expect(calls).toEqual([]);
    expect(read('app.py')).toBe('lokal\n');
  });

  it('rollt bei ungesundem Dienst auf den alten Commit zurück und startet neu', async () => {
    const before = git(work, 'rev-parse', 'HEAD');
    push('app.py', 'v2\n');
    healthy = false;
    await expect(runDeploy(work, 'main', deps())).rejects.toThrowError(/nicht gesund.*wiederhergestellt/);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expect(read('app.py')).toBe('v1\n');
    expect(calls.filter((c) => c === 'systemctl restart helferle-api')).toHaveLength(2); // Deploy + Rücknahme
  });

  it('rollt bei fehlgeschlagener Installation zurück, ohne Dienste anzufassen', async () => {
    const before = git(work, 'rev-parse', 'HEAD');
    push('app.py', 'v2\n');
    installCode = 1;
    await expect(runDeploy(work, 'main', deps())).rejects.toThrowError(/Installation fehlgeschlagen/);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expect(calls.some((c) => c.startsWith('systemctl restart'))).toBe(false);
  });

  it('lehnt ab (mit Rücknahme), wenn das Manifest keinen deploy-Block hat', async () => {
    const before = git(work, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(upstream, '.devdeck', 'workspace.yaml'), 'version: 1\nproject:\n  name: X\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'drop deploy');
    git(upstream, 'push', 'origin', 'main');
    await expect(runDeploy(work, 'main', deps())).rejects.toThrowError(/Kein deploy-Block/);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expect(calls).toEqual([]);
  });
});
