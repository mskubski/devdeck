import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURRENT_AGENT_VERSION, agentSupportsAction, isAgentOutdated, supportsSelfUpdate } from '@devdeck/shared';
import { planUpdate } from '../src/updatePlan.js';

describe('Agent-Update-Plan', () => {
  it('Code neu gepullt: installieren, bauen, neu starten', () => {
    expect(planUpdate('aaa', 'bbb', 'aaa')).toEqual({ install: true, build: true, restart: true });
  });

  it('Server-Rechner: Code liegt schon aktuell auf der Platte, laufender Agent ist älter → nur bauen + neu starten', () => {
    expect(planUpdate('bbb', 'bbb', 'aaa')).toEqual({ install: false, build: true, restart: true });
  });

  it('bereits aktuell und aktuell gestartet: nichts tun', () => {
    expect(planUpdate('bbb', 'bbb', 'bbb')).toEqual({ install: false, build: false, restart: false });
  });

  it('unbekannter Start-Commit: nur nach echtem Pull aktualisieren', () => {
    expect(planUpdate('bbb', 'bbb', null)).toEqual({ install: false, build: false, restart: false });
    expect(planUpdate('aaa', 'bbb', null).restart).toBe(true);
  });

  it('neuere Aktionen nur für Agents mit passender Version', () => {
    expect(agentSupportsAction('0.3.0', 'project.import')).toBe(false);
    expect(agentSupportsAction(null, 'project.import')).toBe(false);
    expect(agentSupportsAction('0.4.0', 'project.import')).toBe(true);
    expect(agentSupportsAction('0.1.0', 'workspace.sync')).toBe(true);
  });

  it('Selbst-Update ab 0.2.0, auch wenn der Agent nicht der neueste ist', () => {
    expect(supportsSelfUpdate('0.1.0')).toBe(false);
    expect(supportsSelfUpdate(null)).toBe(false);
    expect(supportsSelfUpdate('0.2.0')).toBe(true);
    expect(supportsSelfUpdate('0.10.0')).toBe(true);
    expect(isAgentOutdated('0.2.0')).toBe(true);
  });

  // Genau das prüft der Smoke-Test von agent.update vor dem Neustart: `dist/index.js status` startet und meldet die Version.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  it.skipIf(!fs.existsSync(dist))('gebauter Agent meldet Version und Node über „status“ (Basis des Update-Smoke-Tests)', () => {
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-status-')), 'agent.json');
    const out = execFileSync(process.execPath, [dist, 'status'], { env: { ...process.env, DEVDECK_AGENT_CONFIG: cfg }, encoding: 'utf8' });
    const info = JSON.parse(out);
    expect(info.agent_version).toBe(CURRENT_AGENT_VERSION);
    expect(info.node).toBe(process.version);
    expect(info.entry).toBe(dist);
  });
});
