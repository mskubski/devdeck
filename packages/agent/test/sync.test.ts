import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAction } from '../src/actions/index.js';
import '../src/actions/all.js';
import { ServerClient } from '../src/client.js';
import type { AgentConfig } from '../src/config.js';
import { clone } from '../src/git.js';
import { startTestServer, type TestServer } from '../../server/test/helpers.js';

/** Agent-Ebene: echte Git-Repositories (bare Remote) + echter Testserver. */
describe('workspace.sync / workspace.provision (Agent)', () => {
  let srv: TestServer;
  let cookie: string;
  let root: string;
  let machineToken: string;
  let machineId: string;

  const gitSeed = (dir: string, bare: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@test.de'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    fs.mkdirSync(path.join(dir, '.devdeck'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    // Remote SOFORT befüllen (HEAD korrekt setzen), dann klonen
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: dir });
  };

  const manifest = (): string =>
    `version: 1\nproject:\n  name: WebApp\ntools: [git]\n`;

  const manifestWithEnv = (): string =>
    `version: 1\nproject:\n  name: WebApp\nenvironment:\n  source: devdeck\n  target: .env\ntools: [git]\n`;

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login('admin@devdeck.test', 'admin-pass-123');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-agent-'));
    const enrolled = await srv.enroll(cookie, 'Sync-Maschine');
    machineToken = enrolled.token;
    machineId = enrolled.machineId;
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function contextFor() {
    const config: AgentConfig = {
      serverUrl: srv.base,
      machineId,
      machineToken,
      localToken: 'local-test-token',
      workspaceRoot: root,
      localPort: 7420,
      agentVersion: 'test',
    };
    return { client: new ServerClient(config), config };
  }

  /** Manifest in die Arbeitskopie schreiben UND committen (sonst wäre sie dirty). */
  function writeManifest(dir: string, withEnv = false): void {
    fs.mkdirSync(path.join(dir, '.devdeck'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.devdeck', 'workspace.yaml'),
      withEnv ? manifestWithEnv() : manifest(),
    );
    execFileSync('git', ['add', '.devdeck/workspace.yaml'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'manifest'], { cwd: dir });
  }

  function makeOrigin(): string {
    const bare = path.join(root, `origin-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bare });
    return bare;
  }

  it('stoppt den Sync bei lokalen Änderungen (GIT_DIRTY) und ändert nichts', async () => {
    const bare = makeOrigin();
    const seed = path.join(root, 'seed');
    gitSeed(seed, bare);

    const wsPath = path.join(root, 'WebApp');
    await clone(bare, wsPath); // Agent-Funktion: repariert kopflose Remote-HEADs
    execFileSync('git', ['config', 'user.email', 't@test.de'], { cwd: wsPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wsPath });
    writeManifest(wsPath);

    fs.writeFileSync(path.join(wsPath, 'app.txt'), 'lokal geändert\n');

    const handler = getAction('workspace.sync')!;
    const { client, config } = contextFor();
    await expect(
      handler({ client, config, payload: { local_path: wsPath } }),
    ).rejects.toMatchObject({ code: 'GIT_DIRTY' });

    expect(fs.readFileSync(path.join(wsPath, 'app.txt'), 'utf8')).toBe('lokal geändert\n');
    // Sync stoppte: Der lokale Manifest-Commit ist NICHT upstream gepusht worden
    const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsPath }).toString().trim();
    const remoteHead = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: wsPath })
      .toString()
      .trim();
    expect(localHead).not.toBe(remoteHead);
  });

  it('holt neue Upstream-Commits per Fast-Forward', async () => {
    const bare = makeOrigin();
    const seed = path.join(root, 'seed');
    gitSeed(seed, bare);
    fs.writeFileSync(path.join(seed, '.devdeck', 'workspace.yaml'), manifest());
    execFileSync('git', ['add', '-A'], { cwd: seed });
    execFileSync('git', ['commit', '-m', 'manifest'], { cwd: seed });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seed });

    const wsPath = path.join(root, 'WebApp');
    await clone(bare, wsPath); // Agent-Funktion: repariert kopflose Remote-HEADs

    fs.writeFileSync(path.join(seed, 'feature.txt'), 'neu\n');
    execFileSync('git', ['add', '.'], { cwd: seed });
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: seed });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seed });

    const handler = getAction('workspace.sync')!;
    const { client, config } = contextFor();
    const result = (await handler({ client, config, payload: { local_path: wsPath } })) as {
      git: { commit: string };
    };
    expect(fs.readFileSync(path.join(wsPath, 'feature.txt'), 'utf8')).toBe('neu\n');
    expect(result.git.commit).toHaveLength(40);
  });

  it('provisioniert einen frischen Workspace idempotent (ohne Vault/Context vorerst WARNING)', async () => {
    const bare = makeOrigin();
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: seed });
    execFileSync('git', ['config', 'user.email', 't@test.de'], { cwd: seed });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
    fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
    fs.mkdirSync(path.join(seed, '.devdeck'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.devdeck', 'workspace.yaml'), manifest());
    execFileSync('git', ['add', '-A'], { cwd: seed });
    execFileSync('git', ['commit', '-m', 'manifest'], { cwd: seed });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seed });

    const wsPath = path.join(root, 'WebApp');
    const handler = getAction('workspace.provision')!;
    const { client, config } = contextFor();

    const first = (await handler({
      client,
      config,
      payload: { local_path: wsPath, repo_remote: bare, branch: 'main' },
    })) as { overall: string; steps: Array<{ step: string }> };
    // Ohne Vault (Phase G) und Context-Endpunkt (Phase F) sind Secrets/Context
    // kontrolliert übersprungen → WARNING. Klon/Toolchain-Dep-Schritte sind ok.
    expect(first.overall).toBe('WARNING');
    expect(first.steps.map((s) => s.step)).toContain('clone');
    expect(first.steps.map((s) => s.step)).toContain('toolchain');
    expect(fs.existsSync(path.join(wsPath, '.devdeck', 'workspace.yaml'))).toBe(true);

    const second = (await handler({
      client,
      config,
      payload: { local_path: wsPath, repo_remote: bare, branch: 'main' },
    })) as { overall: string };
    expect(second.overall).toBe('WARNING');
  });

  it('lehnt Provisioning außerhalb des Workspace-Root ab', async () => {
    const handler = getAction('workspace.provision')!;
    const { client, config } = contextFor();
    await expect(
      handler({ client, config, payload: { local_path: '/tmp/woanders', repo_remote: 'x' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('stoppt Provisioning bei belegtem Nicht-Git-Verzeichnis', async () => {
    const busy = path.join(root, 'Besetzt');
    fs.mkdirSync(busy, { recursive: true });
    fs.writeFileSync(path.join(busy, 'wichtig.txt'), 'daten\n');
    const handler = getAction('workspace.provision')!;
    const { client, config } = contextFor();
    await expect(
      handler({ client, config, payload: { local_path: busy } }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(fs.readFileSync(path.join(busy, 'wichtig.txt'), 'utf8')).toBe('daten\n');
  });

  it('Action-Registry verwirft jede Aktion außerhalb der Allowlist', async () => {
    const { hasAction } = await import('../src/actions/index.js');
    expect(hasAction('workspace.sync')).toBe(true);
    expect(hasAction('workspace.provision')).toBe(true);
    expect(hasAction('rm -rf /')).toBe(false);
  });
});
