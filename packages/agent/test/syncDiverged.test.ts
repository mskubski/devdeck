import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pullFFOnly } from '../src/git.js';

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();

/** Echte Repositories: bare Remote, ein „Arbeits-PC“ (a) und der Server-Checkout (b), dessen Branch abweicht. */
describe('Sync bei abgewichenem Branch (Agent)', () => {
  let root: string;
  let a: string;
  let b: string;
  let bare: string;

  const commit = (dir: string, file: string, content: string, msg: string): void => {
    fs.writeFileSync(path.join(dir, file), content);
    g(dir, 'add', '-A');
    g(dir, 'commit', '-m', msg);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-div-'));
    bare = path.join(root, 'remote.git');
    a = path.join(root, 'a');
    b = path.join(root, 'b');
    fs.mkdirSync(bare);
    g(bare, 'init', '--bare', '-b', 'main');
    execFileSync('git', ['clone', '-q', bare, a]);
    for (const dir of [a]) {
      g(dir, 'config', 'user.email', 't@test.de');
      g(dir, 'config', 'user.name', 'Test');
      g(dir, 'checkout', '-q', '-B', 'main');
    }
    commit(a, 'app.txt', 'v1\n', 'init');
    g(a, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', bare, b]);
    g(b, 'config', 'user.email', 't@test.de');
    g(b, 'config', 'user.name', 'Test');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lokal nur voraus (nichts Neues auf dem Remote): kein Fehler', async () => {
    commit(b, 'lokal.txt', 'x\n', 'nur lokal');
    await expect(pullFFOnly(b)).resolves.toMatchObject({ updated: false });
  });

  it('reines Vorspulen funktioniert weiter', async () => {
    commit(a, 'neu.txt', 'n\n', 'neu');
    g(a, 'push', '-q');
    await expect(pullFFOnly(b)).resolves.toMatchObject({ updated: true });
    expect(fs.existsSync(path.join(b, 'neu.txt'))).toBe(true);
  });

  it('abgewichen: klare Meldung mit den lokalen Commits, nichts wird verändert', async () => {
    commit(b, 'lokal.txt', 'x\n', 'Nur auf dem Server');
    commit(a, 'neu.txt', 'n\n', 'Vom Arbeits-PC');
    g(a, 'push', '-q');
    const head = g(b, 'rev-parse', 'HEAD');
    const err = await pullFFOnly(b).then(() => null, (e: Error) => e);
    expect(err).toBeTruthy();
    expect((err as { code?: string }).code).toBe('GIT_CONFLICT');
    expect(err!.message.startsWith('Branch abgewichen')).toBe(true);
    expect(err!.message).toContain('Nur auf dem Server');
    expect(err!.message).toContain('1 lokale Commit(s)');
    expect(g(b, 'rev-parse', 'HEAD')).toBe(head);
    expect(g(b, 'status', '--porcelain')).toBe('');
  });

  it('Zusammenführen auf Wunsch: beide Stände vorhanden, Merge-Commit, nichts gepusht', async () => {
    commit(b, 'lokal.txt', 'x\n', 'Nur auf dem Server');
    commit(a, 'neu.txt', 'n\n', 'Vom Arbeits-PC');
    g(a, 'push', '-q');
    const remoteHead = g(bare, 'rev-parse', 'main');
    await expect(pullFFOnly(b, 'merge')).resolves.toMatchObject({ updated: true, merged: true });
    expect(fs.existsSync(path.join(b, 'lokal.txt'))).toBe(true);
    expect(fs.existsSync(path.join(b, 'neu.txt'))).toBe(true);
    expect(g(b, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length).toBe(3); // zwei Eltern
    expect(g(bare, 'rev-parse', 'main')).toBe(remoteHead);
  });

  it('Zusammenführen mit Konflikt: abgebrochen, Arbeitsverzeichnis unverändert', async () => {
    commit(b, 'app.txt', 'server\n', 'Server ändert app.txt');
    commit(a, 'app.txt', 'pc\n', 'PC ändert app.txt');
    g(a, 'push', '-q');
    const head = g(b, 'rev-parse', 'HEAD');
    const err = await pullFFOnly(b, 'merge').then(() => null, (e: Error) => e);
    expect(err!.message).toContain('Konflikte in: app.txt');
    expect(g(b, 'rev-parse', 'HEAD')).toBe(head);
    expect(g(b, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(b, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('server\n');
  });
});
