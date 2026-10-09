import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/manifest.js';

const VALID = `
version: 1
project:
  name: WebApp
runtime:
  node: "24"
package_manager:
  type: npm
  install: npm ci
services:
  supabase: true
mobile:
  android: true
  ios: true
environment:
  source: devdeck
  target: .env
tools:
  - git
  - node
  - npm
  - supabase
`;

describe('workspace.yaml Manifest', () => {
  it('parsed ein gültiges Manifest vollständig', () => {
    const m = parseManifest(VALID);
    expect(m.project.name).toBe('WebApp');
    expect(m.runtime?.node).toBe('24');
    expect(m.package_manager).toEqual({ type: 'npm', install: 'npm ci' });
    expect(m.tools).toContain('supabase');
    expect(m.environment?.target).toBe('.env');
  });

  it('weist fremde Manifest-Versionen zurück', () => {
    expect(() => parseManifest('version: 99\nproject:\n  name: X\n')).toThrowError(/Version 1/);
  });

  it('verlangt project.name', () => {
    expect(() => parseManifest('version: 1\nproject: {}\n')).toThrowError(/project\.name/);
  });

  it('verweigert Shell-Metazeichen im Installationsbefehl', () => {
    const evil = `version: 1\nproject:\n  name: X\npackage_manager:\n  type: npm\n  install: "npm ci; rm -rf /"\n`;
    expect(() => parseManifest(evil)).toThrowError(/unzulässige Zeichen/);
  });

  it('verweigert Verzeichnisse als environment.target', () => {
    const bad = `version: 1\nproject:\n  name: X\nenvironment:\n  target: ../secret.env\n`;
    expect(() => parseManifest(bad)).toThrowError(/Dateiname/);
  });

  it('filtert ungültige Tool-Namen heraus', () => {
    const m = parseManifest(`version: 1\nproject:\n  name: X\ntools: [git, "bös;e", node]\n`);
    expect(m.tools).toEqual(['git', 'node']);
  });
});
