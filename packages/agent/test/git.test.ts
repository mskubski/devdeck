import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clone, git, gitError, gitStatus, isGitRepo } from '../src/git.js';

/** Lokale Git-Repos (bare Remotes) – ohne Netzwerk testbar. */
describe('Git-Helfer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-git-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@test.de'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hallo\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  }

  it('erkennt sauberen und schmutzigen Zustand korrekt', async () => {
    const repo = path.join(tmp, 'repo');
    initRepo(repo);
    expect(await isGitRepo(repo)).toBe(true);

    const clean = await gitStatus(repo);
    expect(clean.dirty).toBe(false);
    expect(clean.branch).toBe('main');
    expect(clean.commit).toHaveLength(40);
    expect(clean.files).toHaveLength(0);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'geändert\n');
    fs.writeFileSync(path.join(repo, 'neu.txt'), 'neu\n');
    const dirty = await gitStatus(repo);
    expect(dirty.dirty).toBe(true);
    expect(dirty.files).toContain('a.txt');
    expect(dirty.files).toContain('neu.txt');
  });

  it('meldet Verzeichnisse ohne Git als Nicht-Repository', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(await isGitRepo(plain)).toBe(false);
  });

  it('klont aus lokalem Bare-Remote und erkennt unerreichbare Remotes', async () => {
    const bare = path.join(tmp, 'origin.git');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bare });

    const src = path.join(tmp, 'src');
    initRepo(src);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: src });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: src });

    const target = path.join(tmp, 'clone');
    await clone(bare, target, 'main');
    expect(await isGitRepo(target)).toBe(true);
    expect(fs.readFileSync(path.join(target, 'a.txt'), 'utf8')).toBe('hallo\n');

    await expect(clone('/does/not/exist.git', path.join(tmp, 'fail'))).rejects.toMatchObject({
      code: 'GIT_UNREACHABLE',
    });
  });

  it('klassifiziert Git-Fehler in strukturierte Codes', async () => {
    expect(
      gitError(
        { code: 128, stdout: '', stderr: "fatal: Could not resolve host 'x'" },
        'fetch',
      ).code,
    ).toBe('GIT_UNREACHABLE');
    expect(
      gitError({ code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict' }, 'pull').code,
    ).toBe('GIT_CONFLICT');
    expect(gitError({ code: 128, stdout: '', stderr: 'not a git repository' }, 'x').code).toBe(
      'GIT_UNREACHABLE',
    );
    await expect(git('/', ['--version'])).resolves.toMatchObject({ code: 0 });
  });
});
