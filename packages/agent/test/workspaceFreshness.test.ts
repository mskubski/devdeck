import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchRemote, gitStatus } from '../src/git.js';
import { buildReadiness } from '../src/readiness.js';
import { parseManifest } from '../src/manifest.js';

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Aktueller GitHub-Stand im Workspace-Status (Agent)', () => {
  let tmp: string;
  let bare: string;
  let vm: string;
  let pc: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-fresh-'));
    bare = path.join(tmp, 'remote.git');
    fs.mkdirSync(bare);
    run(bare, 'init', '--bare', '-b', 'main');
    // „PC“ pusht den ersten Commit, die „VM“ klont ihn
    pc = path.join(tmp, 'pc');
    run(tmp, 'clone', bare, pc);
    for (const [k, v] of [['user.email', 't@test.de'], ['user.name', 'Test']]) run(pc, 'config', k, v);
    fs.writeFileSync(path.join(pc, 'a.txt'), '1');
    run(pc, 'add', '.');
    run(pc, 'commit', '-m', 'init');
    run(pc, 'push', '-u', 'origin', 'HEAD:main');
    vm = path.join(tmp, 'vm');
    run(tmp, 'clone', bare, vm);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('zählt neue Commits erst nach dem Abruf des Remotes – fetchRemote holt sie, ohne das Arbeitsverzeichnis anzufassen', async () => {
    fs.writeFileSync(path.join(pc, 'a.txt'), '2');
    run(pc, 'commit', '-am', 'zweiter Commit vom PC');
    run(pc, 'push', 'origin', 'HEAD:main');

    expect((await gitStatus(vm)).behind).toBe(0); // ohne Fetch kennt die VM den neuen Stand nicht
    expect(await fetchRemote(vm)).toBe(true);
    const after = await gitStatus(vm);
    expect(after.behind).toBe(1);
    expect(after.dirty).toBe(false);
    expect(fs.readFileSync(path.join(vm, 'a.txt'), 'utf8')).toBe('1'); // nur geholt, nicht eingespielt
  });

  it('fetchRemote meldet false statt zu hängen, wenn der Remote nicht erreichbar ist', async () => {
    run(vm, 'remote', 'set-url', 'origin', path.join(tmp, 'gibt-es-nicht.git'));
    expect(await fetchRemote(vm)).toBe(false);
  });

  it('Readiness: bei Deploy-Workspaces „Deploy ausführen“, bei nicht erreichbarem Remote eine Warnung', async () => {
    const manifest = parseManifest('version: 1\nproject:\n  name: X\ndeploy:\n  services:\n    - unit: app\n');
    const base = { workspacePath: vm, isRepo: true, gitAvailable: true };
    const behind = { branch: 'main', commit: 'x', dirty: false, ahead: 0, behind: 3, files: [] };
    const r1 = await buildReadiness({ ...base, manifest, gitState: behind });
    expect(r1.checks.find((c) => c.name === 'GitHub')).toMatchObject({ status: 'WARNING', detail: expect.stringContaining('Deploy ausführen') });
    const r2 = await buildReadiness({ ...base, manifest: null, gitState: behind });
    expect(r2.checks.find((c) => c.name === 'GitHub')!.detail).toContain('Sync ausführen');
    const r3 = await buildReadiness({ ...base, manifest, gitState: { ...behind, behind: 0 }, remoteReachable: false });
    expect(r3.checks.find((c) => c.name === 'GitHub')).toMatchObject({ status: 'WARNING', detail: expect.stringContaining('nicht erreichbar') });
    const r4 = await buildReadiness({ ...base, manifest, gitState: { ...behind, behind: 0 }, remoteReachable: true });
    expect(r4.checks.find((c) => c.name === 'GitHub')!.status).toBe('OK');
  });
});
