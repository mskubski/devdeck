import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLaunchdPlist, buildSystemdUnit, buildWindowsRunValue, getAutostart, setAutostart, type AutostartEnv } from '../src/autostart.js';

describe('Autostart (Agent)', () => {
  let home: string;
  let calls: string[][];
  let enabledNow: boolean;
  const env = (platform: NodeJS.Platform, root = '/opt/devdeck'): AutostartEnv => ({
    platform, home, root, node: '/usr/bin/node',
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes('is-enabled')) return { code: enabledNow ? 0 : 1, stdout: enabledNow ? 'enabled\n' : 'disabled\n' };
      if (args.includes('enable')) enabledNow = true;
      if (args.includes('disable')) enabledNow = false;
      return { code: 0, stdout: '' };
    },
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-autostart-'));
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    calls = [];
    enabledNow = false;
  });
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('Unit, Plist und Windows-Eintrag enthalten Start-Befehl und Arbeitsverzeichnis', () => {
    expect(buildSystemdUnit('/opt/devdeck')).toContain('WorkingDirectory=/opt/devdeck');
    expect(buildSystemdUnit('/opt/devdeck')).toContain('ExecStart=/usr/bin/env node packages/agent/dist/index.js start');
    const plist = buildLaunchdPlist('/usr/local/bin/node', '/opt/a&b/index.js', '/opt/a&b');
    expect(plist).toContain('<string>/opt/a&amp;b/index.js</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(buildWindowsRunValue('C:\\n\\node.exe', 'C:\\d\\index.js', 'C:\\d')).toContain("-FilePath 'C:\\n\\node.exe' -ArgumentList 'C:\\d\\index.js','start'");
  });

  it('Linux: einschalten legt die Unit an und aktiviert sie ohne den Agent zu starten, ausschalten deaktiviert', async () => {
    const on = await setAutostart(true, env('linux'));
    expect(on.enabled).toBe(true);
    expect(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'devdeck-agent.service'))).toBe(true);
    expect(calls.some((c) => c.includes('enable') && !c.includes('--now'))).toBe(true);
    expect((await getAutostart(env('linux'))).enabled).toBe(true);
    const off = await setAutostart(false, env('linux'));
    expect(off.enabled).toBe(false);
  });

  it('macOS: Plist wird angelegt und wieder entfernt, ohne launchctl', async () => {
    const file = path.join(home, 'Library', 'LaunchAgents', 'de.devdeck.agent.plist');
    expect((await setAutostart(true, env('darwin'))).enabled).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect((await setAutostart(false, env('darwin'))).enabled).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('lehnt Pfade mit Sonderzeichen und unbekannte Plattformen ab', async () => {
    await expect(setAutostart(true, env('darwin', "/opt/it's"))).rejects.toThrow(/Sonderzeichen/);
    await expect(setAutostart(true, env('freebsd' as NodeJS.Platform))).rejects.toThrow(/nicht unterstützt/);
  });

  it('Windows: Zustand wird aus der PowerShell-Ausgabe gelesen', async () => {
    const e = env('win32');
    e.run = async () => ({ code: 0, stdout: 'enabled\r\n' });
    expect((await getAutostart(e)).enabled).toBe(true);
  });
});
