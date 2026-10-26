import { describe, expect, it } from 'vitest';
import {
  collectApplications, mapWindowsApps, normalizeApplications, parseBrew, parseDpkg, parseFlatpak, parseMacApps, parsePacman, parseRpm, parseSnap,
} from '../src/applications.js';

describe('Software-Inventar (Agent)', () => {
  it('Windows: übernimmt Programme, ordnet Quellen zu und entfernt Duplikate', () => {
    const apps = mapWindowsApps([
      { name: 'Git', version: '2.55.0.5', publisher: 'The Git Development Community', id: 'Git_is1', source: 'Add or remove programs' },
      { name: 'Box', version: '2.54', publisher: 'Box, Inc.', id: '{ABC}', source: 'MSI' },
      { name: 'Box', version: '2.54', publisher: 'Box, Inc.', id: '{ABC}', source: 'MSI' },
      { name: ' ', version: '1' },
    ]);
    expect(apps.map((a) => a.name)).toEqual(['Box', 'Git']);
    expect(apps[0]).toMatchObject({ identifier: '{ABC}', source: 'MSI' });
  });

  it('Windows: ein einzelnes Objekt (PowerShell-JSON ohne Liste) wird akzeptiert', () => {
    expect(mapWindowsApps({ name: 'Node.js', version: '26.8.1', publisher: 'Node.js Foundation', id: '{X}', source: 'MSI' })).toHaveLength(1);
    expect(mapWindowsApps(null)).toEqual([]);
  });

  it('Linux: dpkg nur installierte Pakete, Maintainer ohne E-Mail', () => {
    const apps = parseDpkg('git\t1:2.47.2-0.2\tJonathan Nieder <jrnieder@gmail.com>\tii \nold\t1.0\tX\trc \n');
    expect(apps).toEqual([{ name: 'git', version: '1:2.47.2-0.2', publisher: 'Jonathan Nieder', identifier: 'git', source: 'dpkg' }]);
  });

  it('Linux: rpm, pacman, snap, flatpak', () => {
    expect(parseRpm('bash\t5.2.26-3\tFedora Project\nfoo\t1-1\t(none)\n')).toMatchObject([{ name: 'bash', publisher: 'Fedora Project' }, { name: 'foo', publisher: null }]);
    expect(parsePacman('linux 6.9.1.arch1-1\n')).toMatchObject([{ name: 'linux', version: '6.9.1.arch1-1', source: 'pacman' }]);
    expect(parseSnap('Name Version Rev Tracking Publisher Notes\ncore22 20240111 1380 latest/stable canonical** base\n')).toMatchObject([{ name: 'core22', publisher: 'canonical', source: 'snap' }]);
    expect(parseFlatpak('org.gimp.GIMP\tGIMP\t2.10.38\tflathub\n')).toMatchObject([{ name: 'GIMP', identifier: 'org.gimp.GIMP', version: '2.10.38', publisher: 'flathub' }]);
  });

  it('macOS: system_profiler und Homebrew', () => {
    const json = JSON.stringify({ SPApplicationsDataType: [
      { _name: 'Safari', version: '18.0', obtained_from: 'apple', path: '/Applications/Safari.app', signed_by: ['Software Signing', 'Apple Code Signing Certification Authority'] },
      { _name: 'Slack', version: '4.40', obtained_from: 'identified_developer', path: '/Applications/Slack.app', signed_by: ['Developer ID Application: Slack Technologies, Inc. (BQR82RBBHL)'] },
    ] });
    const apps = parseMacApps(json);
    expect(apps[0]).toMatchObject({ name: 'Safari', source: 'Apple', identifier: '/Applications/Safari.app' });
    expect(apps[1]).toMatchObject({ publisher: 'Slack Technologies, Inc.', source: 'Identifizierter Entwickler' });
    expect(parseMacApps('kaputt')).toEqual([]);
    expect(parseBrew('git 2.47.0\nnode 22.1.0 21.7.3\n')).toMatchObject([{ name: 'git', version: '2.47.0' }, { name: 'node', version: '22.1.0, 21.7.3' }]);
  });

  it('sortiert nach Name ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    const mk = (name: string) => ({ name, version: null, publisher: null, identifier: null, source: 's' });
    expect(normalizeApplications([mk('zeta'), mk('Alpha'), mk('beta')]).map((a) => a.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('liefert auf dieser Maschine eine Liste, ohne zu scheitern', async () => {
    const apps = await collectApplications();
    expect(Array.isArray(apps)).toBe(true);
    for (const a of apps.slice(0, 5)) expect(a.name).toBeTruthy();
  }, 200_000);
});
