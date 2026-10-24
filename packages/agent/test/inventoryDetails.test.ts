import { describe, expect, it } from 'vitest';
import type { MachineInventory } from '@devdeck/shared';
import { mapWindows, parseDmidecodeMemory, parseIfconfig, parseIpJson, parseLscpu } from '../src/inventory.js';

const blank = (): MachineInventory => ({
  collected_at: 'x', platform: 'win32', hostname: 'h', user: 'u', device: {}, os: {}, disks: [], security: [], network: { ips: [] }, runtime: {},
});

describe('Detail-Inventar (Agent)', () => {
  it('Windows: CPU, BIOS, Speichermodule, Netzwerk und TPM-Details', () => {
    const inv = blank();
    mapWindows({
      extra: {
        cpuInfo: { name: '11th Gen Intel(R) Core(TM) i9-11900K @ 3.50GHz', manufacturer: 'GenuineIntel', cores: 8, threads: 16, mhz: 3504, width: 64, l2: 4096, arch: 9 },
        biosInfo: { manufacturer: 'HP', serial: 'CZC1', smbios: 'T50 Ver. 01.06.12', version: 'HPQOEM - 0', date: '2025-09-01', softwareId: 'T50 Ver. 01.06.12' },
        memory: [
          { manufacturer: 'Samsung', capacity: 17179869184, part: 'M378A2G43AB3-CWE', locator: 'DIMM1', form: 8, speed: 3200 },
          { manufacturer: 'Samsung', capacity: 17179869184, part: 'M378A2G43AB3-CWE', locator: 'DIMM3', form: 8, speed: 3200 },
        ],
        nics: { name: 'Intel(R) Ethernet Connection (14) I219-LM', mac: '00-68-EB-C3-31-94', up: true, v4: '192.168.179.128', v6: ['fe80::1'] },
        tpmName: 'Trusted Platform Module 2.0', tpmIds: 'ACPI\\VEN_IFX&DEV_0785,ACPI\\IFX0785',
      },
    }, inv);
    expect(inv.cpu).toMatchObject({ cores: 8, threads: 16, speed_ghz: 3.5, data_width: 64, l2_cache_kb: 4096, architecture: 'x64' });
    expect(inv.bios_info).toMatchObject({ smbios_version: 'T50 Ver. 01.06.12', release_date: '2025-09-01' });
    expect(inv.memory_modules).toHaveLength(2);
    expect(inv.memory_modules![0]).toMatchObject({ capacity_gb: 16, form_factor: 'DIMM', speed_mhz: 3200, locator: 'DIMM1' });
    expect(inv.network_adapters).toEqual([{ name: 'Intel(R) Ethernet Connection (14) I219-LM', mac: '00:68:EB:C3:31:94', ipv4: ['192.168.179.128'], ipv6: ['fe80::1'], connected: true }]);
    const sec = Object.fromEntries(inv.security.map((s) => [s.label, s]));
    expect(sec['TPM-Hersteller']).toMatchObject({ value: 'IFX', level: 'info' });
    expect(sec['TPM-Spezifikation']).toMatchObject({ value: '2.0', level: 'info' });
  });

  it('Linux: lscpu', () => {
    const cpu = parseLscpu([
      'Architecture:                    x86_64', 'CPU op-mode(s):                  32-bit, 64-bit', 'CPU(s):                          8',
      'Vendor ID:                       GenuineIntel', 'Model name:                      Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz',
      'Core(s) per socket:              4', 'Socket(s):                       1', 'CPU max MHz:                     3400,0000', 'L2 cache:                        1 MiB (4 instances)',
    ].join('\n'));
    expect(cpu).toMatchObject({ name: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', manufacturer: 'GenuineIntel', cores: 4, threads: 8, data_width: 64, l2_cache_kb: 1024, architecture: 'x86_64' });
  });

  it('Linux: dmidecode – leere Steckplätze werden übersprungen', () => {
    const text = [
      'Handle 0x0010, DMI type 17, 40 bytes', 'Memory Device', '\tSize: 16 GB', '\tForm Factor: DIMM', '\tLocator: DIMM1', '\tConfigured Memory Speed: 3200 MT/s',
      '\tManufacturer: Samsung', '\tPart Number: M378A2G43AB3-CWE', '', 'Handle 0x0011, DMI type 17, 40 bytes', 'Memory Device', '\tSize: No Module Installed', '\tLocator: DIMM2', '',
    ].join('\n');
    const mods = parseDmidecodeMemory(text);
    expect(mods).toEqual([{ manufacturer: 'Samsung', capacity_gb: 16, part_number: 'M378A2G43AB3-CWE', locator: 'DIMM1', form_factor: 'DIMM', speed_mhz: 3200 }]);
  });

  it('Linux: ip -j addr filtert Loopback und virtuelle Schnittstellen', () => {
    const json = JSON.stringify([
      { ifname: 'lo', link_type: 'loopback', operstate: 'UNKNOWN', addr_info: [{ family: 'inet', local: '127.0.0.1' }] },
      { ifname: 'eth0', link_type: 'ether', address: 'aa:bb:cc:dd:ee:ff', operstate: 'UP', addr_info: [{ family: 'inet', local: '192.168.1.10' }, { family: 'inet6', local: 'fe80::1' }] },
      { ifname: 'docker0', link_type: 'ether', address: '02:42:00:00:00:00', operstate: 'DOWN', addr_info: [] },
    ]);
    expect(parseIpJson(json)).toEqual([{ name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff', ipv4: ['192.168.1.10'], ipv6: ['fe80::1'], connected: true }]);
    expect(parseIpJson('kaputt')).toEqual([]);
  });

  it('macOS: ifconfig nur enX mit MAC-Adresse', () => {
    const text = [
      'lo0: flags=8049<UP,LOOPBACK> mtu 16384', '\tinet 127.0.0.1 netmask 0xff000000',
      'en0: flags=8863<UP,BROADCAST> mtu 1500', '\tether a4:83:e7:00:11:22', '\tinet6 fe80::1c%en0 prefixlen 64', '\tinet 192.168.0.23 netmask 0xffffff00', '\tstatus: active',
      'en1: flags=8963<UP> mtu 1500', '\tether a4:83:e7:00:11:33', '\tstatus: inactive',
    ].join('\n');
    const nics = parseIfconfig(text);
    expect(nics.map((n) => [n.name, n.connected])).toEqual([['en0', true], ['en1', false]]);
    expect(nics[0]).toMatchObject({ mac: 'a4:83:e7:00:11:22', ipv4: ['192.168.0.23'] });
  });
});
