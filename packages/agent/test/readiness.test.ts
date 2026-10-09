import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReadiness } from '../src/readiness.js';
import { checkTool, requiredTools } from '../src/tools.js';
import type { WorkspaceManifest } from '../src/manifest.js';

describe('Readiness', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-ready-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('meldet BLOCKED bei fehlendem Git und fehlendem Repository', async () => {
    const report = await buildReadiness({
      workspacePath: tmp,
      manifest: null,
      gitState: null,
      isRepo: false,
      gitAvailable: false,
    });
    expect(report.overall).toBe('BLOCKED');
    expect(report.checks.find((c) => c.name === 'Git')?.status).toBe('BLOCKED');
    expect(report.checks.find((c) => c.name === 'Repository')?.status).toBe('BLOCKED');
  });

  it('meldet WARNING bei fehlendem Manifest und fehlendem Kontext', async () => {
    const report = await buildReadiness({
      workspacePath: tmp,
      manifest: null,
      gitState: null,
      isRepo: true,
      gitAvailable: true,
    });
    // Kein package.json → Dependencies OK; fehlende .env/CONTEXT → nur WARNING
    expect(report.overall).toBe('WARNING');
    expect(report.checks.find((c) => c.name === 'Manifest')?.status).toBe('WARNING');
    expect(report.checks.find((c) => c.name === 'Context')?.status).toBe('WARNING');
  });

  it('meldet READY bei komplettem Workspace', async () => {
    const manifest: WorkspaceManifest = {
      version: 1,
      project: { name: 'Webapp-Test' },
      environment: { source: 'devdeck', target: '.env' },
      tools: ['git'],
    };
    fs.writeFileSync(path.join(tmp, '.env'), 'A=1\n');
    fs.mkdirSync(path.join(tmp, '.devdeck'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.devdeck', 'CONTEXT.md'), '# ctx\n');
    const report = await buildReadiness({
      workspacePath: tmp,
      manifest,
      gitState: {
        branch: 'main',
        commit: 'abc',
        dirty: false,
        ahead: 0,
        behind: 0,
        files: [],
      },
      isRepo: true,
      gitAvailable: true,
    });
    expect(report.checks.find((c) => c.name === 'Secrets')?.status).toBe('OK');
    expect(report.checks.find((c) => c.name === 'Context')?.status).toBe('OK');
    // Supabase-Tool ist nicht gefordert → kein WARNING nötig
    expect(report.overall).toBe('READY');
  });

  it('meldet BLOCKED bei fehlenden node_modules', async () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    const report = await buildReadiness({
      workspacePath: tmp,
      manifest: null,
      gitState: null,
      isRepo: true,
      gitAvailable: true,
    });
    expect(report.checks.find((c) => c.name === 'Dependencies')?.status).toBe('BLOCKED');
    expect(report.overall).toBe('BLOCKED');
  });

  it('warnt bei dirty Git ohne zu blockieren (Sync stoppt separat)', async () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'A=1\n');
    const report = await buildReadiness({
      workspacePath: tmp,
      manifest: null,
      gitState: { branch: 'main', commit: 'x', dirty: true, ahead: 0, behind: 0, files: ['a.txt'] },
      isRepo: true,
      gitAvailable: true,
    });
    expect(report.checks.find((c) => c.name === 'Git-Änderungen')?.status).toBe('WARNING');
  });
});

describe('Tool-Erkennung', () => {
  it('erkennt vorhandene Tools und meldet das Level', async () => {
    const gitCheck = await checkTool('git', 'required');
    expect(gitCheck.status).toBe('OK');
    const nodeCheck = await checkTool('node', 'required');
    expect(nodeCheck.status).toBe('OK');
  });

  it('meldet fehlende optionale Tools als WARNING', async () => {
    const check = await checkTool('android-sdk', 'optional');
    expect(['OK', 'WARNING']).toContain(check.status);
  });

  it('meldet unbekannte Pflichttools als BLOCKED', async () => {
    const check = await checkTool('fantom-tool-xyz', 'required');
    expect(check.status).toBe('BLOCKED');
  });

  it('leitet Tools registrybasiert aus dem Manifest ab', () => {
    const manifest: WorkspaceManifest = {
      version: 1,
      project: { name: 'X' },
      runtime: { node: '24' },
      package_manager: { type: 'npm', install: 'npm ci' },
      services: { supabase: true },
      mobile: { android: true, ios: true },
      tools: ['git'],
    };
    const tools = requiredTools(manifest);
    const names = new Map(tools.map((t) => [t.name, t.level]));
    expect(names.get('git')).toBe('required');
    expect(names.get('node')).toBe('required');
    expect(names.get('npm')).toBe('required');
    expect(names.get('supabase')).toBe('optional');
    expect(names.get('android-sdk')).toBe('optional');
    expect(names.get('xcode')).toBe('optional');
  });

  it('überspringt Xcode auf Nicht-macOS (nicht relevant, OK)', async () => {
    if (process.platform === 'darwin') return; // auf macOS hängt es vom Rechner ab
    const check = await checkTool('xcode', 'optional');
    expect(check.status).toBe('OK');
    expect(check.detail).toContain('nicht auf dieser Plattform');
  });
});
