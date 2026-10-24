import { describe, expect, it } from 'vitest';
import type { MachineInventory } from '@devdeck/shared';
import { collectInventory, mapWindows, parseDf, parseOsRelease } from '../src/inventory.js';

const blank = (): MachineInventory => ({
  collected_at: 'x', platform: 'win32', hostname: 'h', user: 'u', device: {}, os: {}, disks: [], security: [], network: { ips: [] }, runtime: {},
});

describe('Geräte-Inventar (Agent)', () => {
  it('liest /etc/os-release', () => {
    const r = parseOsRelease('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_ID="13"\nNAME=Debian\n');
    expect(r.PRETTY_NAME).toBe('Debian GNU/Linux 13 (trixie)');
    expect(r.VERSION_ID).toBe('13');
  });

  it('wertet df aus und ignoriert virtuelle Dateisysteme', () => {
    const df = [
      'Filesystem Type 1-blocks Used Available Capacity Mounted on',
      '/dev/sda2 ext4 500000000000 100000000000 400000000000 20% /',
      'tmpfs tmpfs 1000 0 1000 0% /run',
      '/dev/sda1 vfat 536870912 5000 536000000 1% /boot/efi',
      '/dev/sdb1 ext4 1000000000000 1 999999999999 1% /mnt/daten disk',
    ].join('\n');
    const disks = parseDf(df);
    expect(disks.map((d) => d.name)).toEqual(['/', '/mnt/daten disk']);
    expect(disks[0]).toMatchObject({ label: '/dev/sda2', total_gb: 465.7, free_gb: 372.5 });
  });

  it('übersetzt die Windows-Ausgabe in Felder und Sicherheitsstatus', () => {
    const inv = blank();
    mapWindows({
      manufacturer: 'HP', model: 'Z2 G8', serial: 'CZC1', ram: 34089730048, bios: 'HP - T50 / 2025-09-01',
      osName: 'Microsoft Windows 11 Pro', osVersion: '26H2 10.0.26300.1', language: 'de-DE',
      disks: { name: 'C:', label: '', total: 509896417280, free: 126000000000 },
      secureBoot: false, firewall: [true, true, true], encryption: 2, tpm: true, uac: 1, rebootPending: false,
      mpAv: { enabled: true, realtime: true, sigAge: 0, spyEnabled: true, spyAge: 9 },
    }, inv);
    expect(inv.device).toMatchObject({ manufacturer: 'HP', serial: 'CZC1', ram_gb: 31.75 });
    expect(inv.disks).toEqual([{ name: 'C:', label: null, total_gb: 474.9, free_gb: 117.3 }]);
    const sec = Object.fromEntries(inv.security.map((s) => [s.label, s]));
    expect(sec['Secure Boot']).toMatchObject({ value: 'Deaktiviert', level: 'bad' });
    expect(sec['Laufwerk verschlüsselt (BitLocker)']).toMatchObject({ value: 'Nein', level: 'bad' });
    expect(sec['Spyware-Definitionen']).toMatchObject({ level: 'warn' });
    expect(sec['Firewall']).toMatchObject({ level: 'ok' });
    expect(sec['TPM']).toMatchObject({ value: 'Vorhanden', level: 'ok' });
  });

  it('markiert fehlende Windows-Werte als unbekannt statt zu raten', () => {
    const inv = blank();
    mapWindows({ secureBoot: null, encryption: null, tpm: null, firewall: null, av: null }, inv);
    const sec = Object.fromEntries(inv.security.map((s) => [s.label, s.level]));
    expect(sec['Secure Boot']).toBe('unknown');
    expect(sec['TPM']).toBe('unknown');
    expect(sec['Firewall']).toBe('unknown');
    expect(sec['Virenschutz']).toBe('warn');
  });

  it('liefert auf dieser Maschine mindestens Basisdaten', async () => {
    const inv = await collectInventory();
    expect(inv.platform).toBe(process.platform);
    expect(inv.hostname).toBeTruthy();
    expect(inv.device.ram_gb).toBeGreaterThan(0);
    expect(inv.runtime.node).toBe(process.version);
  }, 90_000);
});
