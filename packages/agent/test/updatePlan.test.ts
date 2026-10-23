import { describe, expect, it } from 'vitest';
import { agentSupportsAction, isAgentOutdated, supportsSelfUpdate } from '@devdeck/shared';
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
});
