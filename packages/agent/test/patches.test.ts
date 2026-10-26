import { describe, expect, it } from 'vitest';
import {
  collectPatches, mapWindowsUpdates, parseApt, parseBrewOutdated, parseCheckupdates, parseDnfCheckUpdate, parseDnfSecurity,
  parseSoftwareUpdate, parseWingetUpgrade, sortPatchItems,
} from '../src/patches.js';

describe('Patch-Stand (Agent)', () => {
  it('Windows: Schweregrad und Kategorie bestimmen den Status, KB-Nummern werden verdichtet', () => {
    const r = mapWindowsUpdates({
      updates: [
        { title: '2026-10 Kumulatives Update (KB5001)', kb: ['5001'], severity: 'Critical', categories: ['Security Updates'] },
        { title: 'Sicherheitsupdate', kb: ['5002', '5003'], severity: 'Important', categories: 'Security Updates' },
        { title: 'Definitionsupdate', kb: '2267602', severity: '', categories: ['Definition Updates'] },
      ],
      hotfixes: { id: 'KB5121794', description: 'Update', installedOn: '2026-10-14' },
      rebootRequired: true,
    });
    expect(r.items.map((i) => i.status)).toEqual(['critical', 'security', 'update']);
    expect(r.items[1]).toMatchObject({ available: 'KB5002, KB5003', vendor: 'Microsoft', kind: 'os' });
    expect(r.installed).toEqual([{ id: 'KB5121794', description: 'Update', installed_on: '2026-10-14' }]);
    expect(r.reboot).toBe(true);
    expect(mapWindowsUpdates({ updates: [], searchError: 'Netz weg' }).error).toBe('Netz weg');
  });

  it('winget: Spalten nach Kopfzeile, Fußzeile wird ignoriert', () => {
    const text = [
      '   - \\ | ',
      'Name               ID                         Version      Verfügbar    Quelle',
      '------------------------------------------------------------------------------',
      'Visual Studio Code Microsoft.VisualStudioCode 1.135.0      1.136.2      winget',
      'Git                Git.Git                    2.55.0.5     2.56.0.1     winget',
      '',
      '2 Aktualisierungen verfügbar.',
    ].join('\n');
    const r = parseWingetUpgrade(text);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ name: 'Visual Studio Code', vendor: 'Microsoft', version: '1.135.0', available: '1.136.2', kind: 'app', status: 'update', detail: 'Microsoft.VisualStudioCode' });
    expect(parseWingetUpgrade('Keine Aktualisierungen')).toEqual([]);
  });

  it('Linux: apt markiert Sicherheits-Suiten', () => {
    const r = parseApt([
      'Listing... Done',
      'openssl/stable-security 3.0.15-1 amd64 [upgradable from: 3.0.14-1]',
      'vim/stable 2:9.0.1378-2 amd64 [upgradable from: 2:9.0.1378-1]',
    ].join('\n'));
    expect(r).toMatchObject([{ name: 'openssl', status: 'security', version: '3.0.14-1', available: '3.0.15-1' }, { name: 'vim', status: 'update' }]);
  });

  it('Linux: dnf mit Sicherheitsmeldungen, pacman checkupdates', () => {
    const sec = parseDnfSecurity('FEDORA-2024-abc Critical/Sec. openssl-1:3.2.1-2.fc40.x86_64\nFEDORA-2024-def Moderate/Sec. curl-8.6.0-7.fc40.x86_64\n');
    expect([...sec.entries()]).toEqual([['openssl', 'critical'], ['curl', 'security']]);
    const r = parseDnfCheckUpdate('\nopenssl.x86_64   1:3.2.2-1.fc40   updates\nbash.x86_64   5.2.30-1.fc40   updates\n\nObsoleting Packages\nfoo.x86_64 1 x\n', sec);
    expect(r.map((i) => [i.name, i.status])).toEqual([['openssl', 'critical'], ['bash', 'update']]);
    expect(parseCheckupdates('linux 6.9.1-1 -> 6.9.2-1\n')).toMatchObject([{ name: 'linux', version: '6.9.1-1', available: '6.9.2-1' }]);
  });

  it('macOS: softwareupdate und Homebrew', () => {
    const text = [
      'Software Update Tool', '', 'Finding available software', 'Software Update found the following new or updated software:',
      '* Label: macOS Sequoia 15.1-24B83', '\tTitle: macOS Sequoia 15.1, Version: 15.1, Size: 3000000KiB, Recommended: YES, Action: restart,',
      '* Label: Safari18.1-18.1', '\tTitle: Safari, Version: 18.1, Size: 150000KiB, Recommended: YES,',
    ].join('\n');
    const r = parseSoftwareUpdate(text);
    expect(r).toMatchObject([{ name: 'macOS Sequoia 15.1', available: '15.1', vendor: 'Apple' }, { name: 'Safari' }]);
    expect(r[0]!.detail).toContain('Neustart');
    expect(parseSoftwareUpdate('No new software available.')).toEqual([]);
    expect(parseBrewOutdated('node (22.1.0, 21.7.3) < 22.2.0\ngit (2.46.0) != 2.47.0\n')).toMatchObject([{ name: 'node', version: '22.1.0, 21.7.3', available: '22.2.0' }, { name: 'git' }]);
  });

  it('sortiert kritisch vor Sicherheit vor Update', () => {
    const mk = (name: string, status: 'critical' | 'security' | 'update') => ({ vendor: null, name, version: null, available: null, status, kind: 'os' as const, detail: null });
    expect(sortPatchItems([mk('b', 'update'), mk('a', 'security'), mk('c', 'critical')]).map((i) => i.name)).toEqual(['c', 'a', 'b']);
  });

  it('liefert auf dieser Maschine eine Zusammenfassung, ohne zu scheitern', async () => {
    const p = await collectPatches();
    expect(p.total).toBe(p.items.length);
    expect(p.scanner).toBeTruthy();
    expect(Array.isArray(p.notes)).toBe(true);
  }, 400_000);
});
