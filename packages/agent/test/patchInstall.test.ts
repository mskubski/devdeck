import { describe, expect, it } from 'vitest';
import type { MachinePatchItem, MachinePatches } from '@devdeck/shared';
import { installPatches, parseWindowsInstall, planUnixSteps, validateIds, windowsInstallScript, type InstallDeps } from '../src/patchInstall.js';

const GUID_A = '11111111-2222-3333-4444-555555555555';
const item = (id: string, over: Partial<MachinePatchItem> = {}): MachinePatchItem => ({
  vendor: null, name: `Paket ${id}`, version: '1', available: '2', status: 'security', kind: 'os', detail: null, id, ...over,
});
const scan = (items: MachinePatchItem[], over: Partial<MachinePatches> = {}): MachinePatches => ({
  collected_at: new Date().toISOString(), scanner: 'apt', total: items.length, critical: 0, security: items.length,
  reboot_required: false, last_installed_at: null, items, installed: [], notes: [], ...over,
});

/** Fake-System: erster Scan liefert `before`, danach `after`; alle Aufrufe werden protokolliert. */
function deps(platform: NodeJS.Platform, before: MachinePatches, after: MachinePatches, run?: InstallDeps['run'], isRoot = false) {
  const calls: string[][] = [];
  let scans = 0;
  const d: InstallDeps = {
    platform, isRoot,
    scan: async () => (scans++ === 0 ? before : after),
    run: async (file, args, opts) => {
      calls.push([file, ...args]);
      return run ? run(file, args, opts) : { code: 0, stdout: '', stderr: '' };
    },
  };
  return { d, calls };
}

describe('Patch-Installation (Agent)', () => {
  it('weist ungültige Kennungen ab (keine Optionen, keine Sonderzeichen, Obergrenze)', () => {
    expect(() => validateIds([])).toThrow();
    expect(() => validateIds('x')).toThrow();
    expect(() => validateIds(['--help'])).toThrow(/Ungültig/);
    expect(() => validateIds(['a; rm -rf /'])).toThrow(/Ungültig/);
    expect(() => validateIds(['a$(id)'])).toThrow(/Ungültig/);
    expect(() => validateIds(Array.from({ length: 101 }, (_, i) => `p${i}`))).toThrow(/Höchstens/);
    expect(validateIds(['openssl', 'openssl', 'macOS Sequoia 15.1-24B83'])).toEqual(['openssl', 'macOS Sequoia 15.1-24B83']);
  });

  it('Linux/apt: installiert nur gemeldete Updates über sudo -n, meldet Ergebnis und löst nie einen Neustart aus', async () => {
    const { d, calls } = deps('linux', scan([item('openssl'), item('curl')]), scan([item('curl')], { reboot_required: true }));
    const r = await installPatches(['openssl', 'unbekannt'], d);
    expect(calls[0]).toEqual(['sudo', '-n', 'true']);
    expect(calls[1]).toEqual(['sudo', '-n', 'apt-get', 'install', '--only-upgrade', '-y', '-o', 'Dpkg::Options::=--force-confold', 'openssl']);
    expect(r.results).toEqual([
      { id: 'openssl', name: 'Paket openssl', ok: true, message: 'Installiert' },
      { id: 'unbekannt', name: null, ok: false, message: 'Wird nicht (mehr) als ausstehend gemeldet' },
    ]);
    expect(r.reboot_required).toBe(true);
    expect(r.patches.reboot_required).toBe(true);
    expect(calls.flat().some((a) => /reboot|shutdown|restart|systemctl/i.test(a))).toBe(false);
  });

  it('Linux: als root ohne sudo; ohne sudo-Rechte schlägt es mit Hinweis fehl', async () => {
    const root = deps('linux', scan([item('openssl')]), scan([]), undefined, true);
    await installPatches(['openssl'], root.d);
    expect(root.calls[0]![0]).toBe('apt-get');

    const nosudo = deps('linux', scan([item('openssl')]), scan([item('openssl')]), async (file, args) => (file === 'sudo' && args.includes('true') ? { code: 1, stdout: '', stderr: 'password required' } : { code: 0, stdout: '', stderr: '' }));
    const r = await installPatches(['openssl'], nosudo.d);
    expect(r.results[0]).toMatchObject({ ok: false });
    expect(r.results[0]!.message).toMatch(/sudoers/);
    expect(nosudo.calls.filter((c) => c.includes('apt-get'))).toEqual([]);
  });

  it('meldet Fehler des Paketmanagers pro Update, wenn es danach noch aussteht', async () => {
    const { d } = deps('linux', scan([item('openssl')]), scan([item('openssl')]), async (file, args) => (args.includes('apt-get') ? { code: 100, stdout: '', stderr: 'E: Unable to lock the administration directory' } : { code: 0, stdout: '', stderr: '' }));
    const r = await installPatches(['openssl'], d);
    expect(r.results[0]).toMatchObject({ ok: false, message: 'apt-get: E: Unable to lock the administration directory' });
  });

  it('macOS: softwareupdate je Label mit sudo, Homebrew ohne; Neustart-Hinweis aus der Meldung', async () => {
    const os = item('macOS Sequoia 15.1-24B83', { detail: 'macOS Sequoia 15.1-24B83 (Neustart nötig)' });
    const app = item('git', { kind: 'app', status: 'update' });
    const { d, calls } = deps('darwin', scan([os, app], { scanner: 'softwareupdate, Homebrew', reboot_required: null }), scan([], { reboot_required: null }));
    const r = await installPatches([os.id!, 'git'], d);
    expect(calls).toContainEqual(['sudo', '-n', 'softwareupdate', '-i', 'macOS Sequoia 15.1-24B83']);
    expect(calls).toContainEqual(['brew', 'upgrade', 'git']);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(r.reboot_required).toBe(true);
  });

  it('planUnixSteps: Arch (pacman) wird nicht unterstützt', () => {
    expect(planUnixSteps('linux', 'pacman (checkupdates)', { os: ['linux'], app: [] }).unsupported).toMatch(/nicht unterstützt/);
    expect(planUnixSteps('linux', 'dnf', { os: ['openssl'], app: [] }).steps[0]).toMatchObject({ file: 'dnf', args: ['-y', 'upgrade', 'openssl'], needsRoot: true });
  });

  it('Windows: Skript enthält nur GUIDs, winget je ID, Ergebnis und Neustart aus der Antwort', async () => {
    expect(windowsInstallScript([GUID_A])).toContain(`'${GUID_A}'`);
    expect(() => windowsInstallScript(["x'; calc; '"])).toThrow(/Ungültige/);
    const win = item(GUID_A, { status: 'critical' });
    const app = item('Git.Git', { kind: 'app', status: 'update' });
    const before = scan([win, app], { scanner: 'Windows Update Agent, winget' });
    const after = scan([], { scanner: 'Windows Update Agent, winget', reboot_required: false });
    const { d, calls } = deps('win32', before, after, async (file) => (file === 'powershell.exe'
      ? { code: 0, stdout: JSON.stringify({ admin: true, items: [{ id: GUID_A, code: 2, hresult: 0 }], reboot: true }), stderr: '' }
      : { code: 0, stdout: '', stderr: '' }));
    const r = await installPatches([GUID_A, 'Git.Git'], d);
    expect(calls.find((c) => c[0] === 'winget')).toEqual(['winget', 'upgrade', '--id', 'Git.Git', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(r.reboot_required).toBe(true);
  });

  it('Windows: ohne Administratorrechte bzw. mit Fehlercode gibt es verständliche Meldungen', () => {
    expect(parseWindowsInstall(JSON.stringify({ admin: false }), [GUID_A]).failures.get(GUID_A)).toMatch(/Administrator/);
    expect(parseWindowsInstall(JSON.stringify({ admin: true, items: { id: GUID_A, code: 4, hresult: -2145124322 } }), [GUID_A]).failures.get(GUID_A)).toMatch(/Ergebnis 4/);
    expect(parseWindowsInstall('kaputt', [GUID_A]).failures.get(GUID_A)).toMatch(/auswertbare/);
    expect(parseWindowsInstall(JSON.stringify({ admin: true, items: [{ id: GUID_A, code: 2 }], reboot: false }), [GUID_A]).failures.size).toBe(0);
  });
});
