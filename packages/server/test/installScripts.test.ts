import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reines Browser-Modul (JavaScript ohne Typen) – über einen Pfad laden, damit TypeScript es nicht prüft
const mod: any = await import(pathToFileURL(path.resolve(__dirname, '../src/webui/lib/installScripts.js')).href);

const base = { server: 'https://devdeck.example:8080/', token: 'abcDEF1234567890_-xyz', name: '', installPath: '', workspaceRoot: '', autostart: true };

describe('Installationsskripte für den Agent (Web UI)', () => {
  it('prüft Eingaben und lehnt Zeichen ab, die Befehle einschleusen könnten', () => {
    expect(mod.validateInstall(base)).toBeNull();
    expect(mod.validateInstall({ ...base, server: 'ftp://x' })).toMatch(/Server/);
    expect(mod.validateInstall({ ...base, server: "http://x'; rm -rf ~; '" })).toMatch(/Server/);
    expect(mod.validateInstall({ ...base, token: "abc'; calc; '" })).toMatch(/Token/);
    expect(mod.validateInstall({ ...base, name: 'PC$(id)' })).toMatch(/Maschinenname/);
    expect(mod.validateInstall({ ...base, installPath: 'C:\\x"; calc' })).toMatch(/Installationsordner/);
    expect(mod.validateInstall({ ...base, workspaceRoot: '/tmp/`id`' })).toMatch(/Workspace-Root/);
    expect(mod.validateInstall({ ...base, branch: 'main; id' })).toMatch(/Branch/);
    expect(mod.validateInstall({ ...base, repo: 'http://evil' })).toMatch(/Repository/);
  });

  it('Befehle: je System mit Server ohne Schrägstrich am Ende, Autostart nur auf Wunsch, Standardpfade erst auf der Maschine ausgewertet', () => {
    const win = mod.installCommands('windows', base);
    expect(win).toContain("enroll --server 'https://devdeck.example:8080' --token 'abcDEF1234567890_-xyz'");
    expect(win).toContain('"$HOME\\devdeck"');
    expect(win).toContain('autostart on');
    expect(win.trim().split('\n').pop()).toContain('start-background');
    const lin = mod.installCommands('linux', { ...base, autostart: false, name: "Lager PC", installPath: '/opt/devdeck' });
    expect(lin).not.toContain('autostart on');
    expect(lin).toContain("git clone --branch 'main' 'https://github.com/mskubski/devdeck.git' '/opt/devdeck'");
    expect(lin).toContain("--name 'Lager PC'");
    expect(mod.installCommands('macos', base)).toContain('brew install git node');
  });

  it('Skript: Windows mit BOM und CRLF, Unix mit Rückfragen (Autostart, Pfade, Name) und Standardwerten aus dem Formular', () => {
    const win = mod.installScript('windows', { ...base, name: "O'Neil", workspaceRoot: 'D:\\Dev' });
    expect(win.filename).toBe('install-devdeck-agent.ps1');
    expect(win.content.startsWith('\uFEFF')).toBe(true);
    expect(win.content).toContain('\r\n');
    expect(win.content).toContain("$Token = 'abcDEF1234567890_-xyz'");
    expect(win.content).toContain("Ask 'Name dieser Maschine in DevDeck' 'O''Neil'");
    expect(win.content).toContain("Ask 'Workspace-Root (hier legt DevDeck Projekte ab)' 'D:\\Dev'");
    expect(win.content).toContain('Agent beim Anmelden automatisch starten?');

    for (const os of ['linux', 'macos']) {
      const sh = mod.installScript(os, { ...base, autostart: false });
      expect(sh.filename).toBe('install-devdeck-agent.sh');
      expect(sh.content.startsWith('#!/usr/bin/env bash')).toBe(true);
      expect(sh.content).not.toContain('\r');
      expect(sh.content).toContain("TOKEN='abcDEF1234567890_-xyz'");
      expect(sh.content).toMatch(/automatisch starten\?' 'N'/);
      expect(sh.content).toContain('autostart on');
      expect(sh.content).toContain('start-background');
    }
    expect(mod.installScript('linux', base).content).toMatch(/automatisch starten\?' 'J'/);
  });

  it('erkennt das Betriebssystem des Browsers', () => {
    expect(mod.guessOs('Win32')).toBe('windows');
    expect(mod.guessOs('MacIntel')).toBe('macos');
    expect(mod.guessOs('Linux x86_64')).toBe('linux');
  });
});
