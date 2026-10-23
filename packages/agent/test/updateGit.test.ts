import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fastForwardToTarget, rollbackMove } from '../src/updateGit.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('Agent-Update: Git-Zielbranch (fast-forward auf origin/main)', () => {
  let tmp: string;
  let bare: string;
  let dev: string;
  let prod: string;

  const commit = (dir: string, file: string, msg: string): void => {
    fs.writeFileSync(path.join(dir, file), msg);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', msg);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-ug-'));
    bare = path.join(tmp, 'origin.git');
    dev = path.join(tmp, 'dev');
    prod = path.join(tmp, 'prod');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['clone', bare, dev], { stdio: 'ignore' });
    for (const d of [dev]) {
      git(d, 'config', 'user.email', 't@t.de');
      git(d, 'config', 'user.name', 'T');
    }
    git(dev, 'checkout', '-b', 'main');
    commit(dev, 'a.txt', 'v1');
    git(dev, 'push', 'origin', 'main');
    execFileSync('git', ['clone', bare, prod], { stdio: 'ignore' });
    git(prod, 'config', 'user.email', 't@t.de');
    git(prod, 'config', 'user.name', 'T');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('zieht neuen Stand von main per Fast-Forward', async () => {
    commit(dev, 'a.txt', 'v2');
    git(dev, 'push', 'origin', 'main');
    const move = await fastForwardToTarget(prod, 'main');
    expect(move).toMatchObject({ beforeBranch: 'main', switched: false });
    expect(move.before).not.toBe(move.after);
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('v2');
  });

  it('wechselt von einem gemergten Feature-Branch, dessen Remote gelöscht wurde, auf main (der gemeldete Fehler)', async () => {
    // prod steht auf feature/x mit Upstream; der Remote-Branch wird nach dem Merge gelöscht
    git(dev, 'checkout', '-b', 'feature/x');
    commit(dev, 'b.txt', 'feature');
    git(dev, 'push', '-u', 'origin', 'feature/x');
    git(prod, 'fetch', 'origin');
    git(prod, 'checkout', 'feature/x');
    git(dev, 'checkout', 'main');
    git(dev, 'merge', '--no-ff', 'feature/x', '-m', 'merge feature');
    commit(dev, 'c.txt', 'nach dem Merge');
    git(dev, 'push', 'origin', 'main');
    git(dev, 'push', 'origin', '--delete', 'feature/x');

    // „git pull --ff-only“ scheitert hier mit „no such ref was fetched“ – genau das passierte auf debian01
    expect(() => git(prod, 'pull', '--ff-only')).toThrow(/no such ref was fetched|no tracking information/);

    const move = await fastForwardToTarget(prod, 'main');
    expect(move).toMatchObject({ beforeBranch: 'feature/x', switched: true });
    expect(git(prod, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(prod, 'log', '-1', '--format=%s')).toBe('nach dem Merge');
  });

  it('bricht ohne Fast-Forward ab und lässt den Ordner auf dem ursprünglichen Branch', async () => {
    git(prod, 'checkout', '-b', 'lokal');
    commit(prod, 'lokal.txt', 'nur lokal');
    git(prod, 'checkout', 'main');
    commit(prod, 'divergiert.txt', 'lokaler Commit auf main');
    commit(dev, 'a.txt', 'v2');
    git(dev, 'push', 'origin', 'main');
    git(prod, 'checkout', 'lokal');
    await expect(fastForwardToTarget(prod, 'main')).rejects.toMatchObject({ code: 'GIT_CONFLICT' });
    expect(git(prod, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lokal');
  });

  it('meldet unerreichbares Remote verständlich', async () => {
    git(prod, 'remote', 'set-url', 'origin', path.join(tmp, 'gibt-es-nicht.git'));
    await expect(fastForwardToTarget(prod, 'main')).rejects.toMatchObject({ code: 'GIT_UNREACHABLE' });
  });

  it('rollbackMove stellt Branch und Stand wieder her', async () => {
    git(prod, 'checkout', '-b', 'alt');
    const head = git(prod, 'rev-parse', 'HEAD');
    commit(dev, 'a.txt', 'v2');
    git(dev, 'push', 'origin', 'main');
    const move = await fastForwardToTarget(prod, 'main');
    expect(git(prod, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    await rollbackMove(prod, move);
    expect(git(prod, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('alt');
    expect(git(prod, 'rev-parse', 'HEAD')).toBe(head);
  });
});
