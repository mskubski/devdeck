import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { InventoryLevel, MachineInventory } from '@devdeck/shared';

const exec = promisify(execFile);

/** Befehl ohne Shell ausführen; bei Fehler/Timeout leerer String (jede Sonde ist optional). */
async function out(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { timeout, windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    // Manche Werkzeuge (z. B. csrutil) liefern die Antwort trotz Exit-Code ≠ 0
    const e = err as { stdout?: string };
    return typeof e.stdout === 'string' ? e.stdout.trim() : '';
  }
}

const readFile = (p: string): string | null => {
  try {
    return fs.readFileSync(p, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

const gb = (bytes: number, digits = 1): number => Math.round((bytes / 1024 ** 3) * 10 ** digits) / 10 ** digits;
const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return v == null ? null : String(v);
  const t = v.trim();
  // Typische Platzhalter der Hersteller sind keine Information
  return t === '' || /^(to be filled by o\.e\.m\.|default string|system product name|not specified|none|n\/a)$/i.test(t) ? null : t;
};
const sec = (label: string, value: string, level: InventoryLevel): { label: string; value: string; level: InventoryLevel } => ({ label, value, level });
const yesNo = (label: string, v: boolean | null | undefined, goodWhenTrue = true, yes = 'Ja', no = 'Nein') =>
  v === null || v === undefined ? sec(label, 'Unbekannt', 'unknown') : sec(label, v ? yes : no, v === goodWhenTrue ? 'ok' : 'bad');

/** Gemeinsame Basisdaten aus Node (alle Plattformen). */
function base(): MachineInventory {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (!i.internal && i.family === 'IPv4') ips.push(i.address);
  }
  const cpu = os.cpus()[0];
  let user: string | null = null;
  try {
    user = os.userInfo().username;
  } catch {
    user = null;
  }
  return {
    collected_at: new Date().toISOString(),
    platform: process.platform,
    hostname: os.hostname(),
    user,
    device: {
      processor: cpu ? clean(cpu.model.replace(/\s+/g, ' ')) : null,
      ram_gb: gb(os.totalmem(), 2),
    },
    os: { arch: os.arch(), kernel: os.release(), language: clean(Intl.DateTimeFormat().resolvedOptions().locale) },
    disks: [],
    security: [],
    network: { ips },
    runtime: { boot_time: new Date(Date.now() - os.uptime() * 1000).toISOString(), node: process.version },
  };
}

// ───────────────────────────── Linux ─────────────────────────────

export function parseOsRelease(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) result[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return result;
}

/** `df -P -B1 -T`-Ausgabe → Datenträger (nur echte Dateisysteme). */
export function parseDf(text: string): MachineInventory['disks'] {
  const skipFs = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'ramfs', 'proc', 'sysfs', 'cgroup2', 'fuse.gvfsd-fuse']);
  const disks: MachineInventory['disks'] = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [device, fsType, total, , free] = parts;
    const mount = parts.slice(6).join(' ');
    if (skipFs.has(fsType!) || /^\/(snap|run|dev|sys|proc|boot\/efi)(\/|$)/.test(mount)) continue;
    const t = Number(total);
    const f = Number(free);
    if (!Number.isFinite(t) || t <= 0) continue;
    disks.push({ name: mount, label: device ?? null, total_gb: gb(t), free_gb: gb(f) });
  }
  return disks.slice(0, 20);
}

async function linux(inv: MachineInventory): Promise<void> {
  const dmi = (n: string): string | null => clean(readFile(`/sys/class/dmi/id/${n}`));
  const tree = clean(readFile('/proc/device-tree/model')?.replace(/\0/g, '') ?? null);
  inv.device.manufacturer = dmi('sys_vendor') ?? dmi('board_vendor');
  inv.device.model = dmi('product_name') ?? tree ?? dmi('board_name');
  inv.device.version = dmi('product_version');
  inv.device.serial = dmi('product_serial') ?? clean(readFile('/proc/device-tree/serial-number')?.replace(/\0/g, '') ?? null);
  const biosVersion = dmi('bios_version');
  inv.device.bios = biosVersion ? [dmi('bios_vendor'), biosVersion, dmi('bios_date')].filter(Boolean).join(' / ') : null;

  const rel = parseOsRelease(readFile('/etc/os-release') ?? '');
  inv.os.name = clean(rel.PRETTY_NAME ?? rel.NAME ?? 'Linux');
  inv.os.version = clean(rel.VERSION_ID ?? null);
  inv.os.build = clean(rel.BUILD_ID ?? null);
  inv.os.language = clean(process.env.LANG?.split('.')[0] ?? inv.os.language ?? null);

  inv.disks = parseDf(await out('df', ['-P', '-B1', '-T']));

  // Secure Boot: 5. Byte der EFI-Variable (0/1); ohne UEFI-Variablen unbekannt
  try {
    const dir = '/sys/firmware/efi/efivars';
    if (!fs.existsSync('/sys/firmware/efi')) inv.security.push(sec('Secure Boot', 'Kein UEFI', 'unknown'));
    else {
      const name = fs.readdirSync(dir).find((f) => f.startsWith('SecureBoot-'));
      const bytes = name ? fs.readFileSync(`${dir}/${name}`) : null;
      inv.security.push(bytes && bytes.length >= 5 ? yesNo('Secure Boot', bytes[4] === 1, true, 'Aktiviert', 'Deaktiviert') : sec('Secure Boot', 'Unbekannt', 'unknown'));
    }
  } catch {
    inv.security.push(sec('Secure Boot', 'Unbekannt', 'unknown'));
  }
  const active: string[] = [];
  for (const unit of ['ufw', 'firewalld', 'nftables']) {
    if ((await out('systemctl', ['is-active', unit], 5_000)).split('\n').pop() === 'active') active.push(unit);
  }
  inv.security.push(active.length ? sec('Firewall', `Aktiv (${active.join(', ')})`, 'ok') : sec('Firewall', 'Kein aktiver Dienst erkannt (ufw/firewalld/nftables)', 'warn'));
  const lsblk = await out('lsblk', ['-rno', 'TYPE'], 5_000);
  inv.security.push(lsblk ? yesNo('Datenträger verschlüsselt', /^crypt$/m.test(lsblk), true, 'Ja (LUKS)', 'Nein') : sec('Datenträger verschlüsselt', 'Unbekannt', 'unknown'));
  inv.security.push(yesNo('TPM', fs.existsSync('/sys/class/tpm/tpm0'), true, 'Vorhanden', 'Nicht erkannt'));
  const reboot = fs.existsSync('/var/run/reboot-required');
  inv.security.push(reboot ? sec('Neustart ausstehend', 'Ja (Updates)', 'warn') : sec('Neustart ausstehend', 'Nein', 'ok'));
  await linuxDetails(inv);
}

/** `lscpu`-Ausgabe → CPU-Details. */
export function parseLscpu(text: string): NonNullable<MachineInventory['cpu']> {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const sockets = Number(kv['Socket(s)']) || 1;
  const perSocket = Number(kv['Core(s) per socket']);
  const maxMhz = Number(kv['CPU max MHz']) || Number(kv['CPU MHz']) || 0;
  const l2 = /([\d.]+)\s*(KiB|MiB)/i.exec(kv['L2 cache'] ?? '');
  return {
    name: clean(kv['Model name']), manufacturer: clean(kv['Vendor ID']), description: null,
    cores: perSocket ? perSocket * sockets : null, threads: Number(kv['CPU(s)']) || null,
    speed_ghz: maxMhz ? Math.round(maxMhz / 100) / 10 : null,
    data_width: /64-bit/.test(kv['CPU op-mode(s)'] ?? '') ? 64 : /32-bit/.test(kv['CPU op-mode(s)'] ?? '') ? 32 : null,
    l2_cache_kb: l2 ? Math.round(Number(l2[1]) * (l2[2]!.toLowerCase() === 'mib' ? 1024 : 1)) : null,
    architecture: clean(kv.Architecture),
  };
}

/** `dmidecode -t memory`-Ausgabe → Speichermodule (nur belegte Steckplätze). */
export function parseDmidecodeMemory(text: string): NonNullable<MachineInventory['memory_modules']> {
  const modules: NonNullable<MachineInventory['memory_modules']> = [];
  for (const block of text.split(/\n\s*\n/)) {
    if (!/^Memory Device/m.test(block)) continue;
    const f = (k: string): string | null => clean(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(block)?.[1] ?? null);
    const size = /^\s*Size:\s*(\d+)\s*(MB|GB)/m.exec(block);
    if (!size) continue; // „No Module Installed“
    const speed = /^\s*(?:Configured Memory Speed|Speed):\s*(\d+)/m.exec(block);
    modules.push({
      manufacturer: f('Manufacturer'), capacity_gb: size[2] === 'GB' ? Number(size[1]) : Math.round((Number(size[1]) / 1024) * 100) / 100,
      part_number: f('Part Number'), locator: f('Locator'), form_factor: f('Form Factor'), speed_mhz: speed ? Number(speed[1]) : null,
    });
  }
  return modules.slice(0, 64);
}

/** `ip -j addr`-Ausgabe → Netzwerkverbindungen (ohne Loopback und virtuelle Schnittstellen). */
export function parseIpJson(json: string): NonNullable<MachineInventory['network_adapters']> {
  try {
    const list = JSON.parse(json) as Array<{ ifname: string; address?: string; operstate?: string; link_type?: string; addr_info?: Array<{ family: string; local: string }> }>;
    return list
      .filter((i) => i.link_type !== 'loopback' && !/^(lo|docker|veth|br-|virbr|tun|tap)/.test(i.ifname))
      .map((i) => ({
        name: i.ifname, mac: clean(i.address),
        ipv4: (i.addr_info ?? []).filter((a) => a.family === 'inet').map((a) => a.local),
        ipv6: (i.addr_info ?? []).filter((a) => a.family === 'inet6').map((a) => a.local),
        connected: i.operstate === 'UP',
      })).slice(0, 20);
  } catch {
    return [];
  }
}

async function linuxDetails(inv: MachineInventory): Promise<void> {
  const lscpu = await out('lscpu', [], 8_000);
  if (lscpu) inv.cpu = parseLscpu(lscpu);
  const dmi = (n: string): string | null => clean(readFile(`/sys/class/dmi/id/${n}`));
  const biosVersion = dmi('bios_version');
  if (biosVersion) {
    inv.bios_info = { manufacturer: dmi('bios_vendor'), serial: dmi('product_serial'), smbios_version: null, version: biosVersion, release_date: dmi('bios_date'), software_id: null };
  }
  // Speichermodule brauchen Root (dmidecode); ohne Rechte bleibt die Liste leer
  const mem = await out('dmidecode', ['-t', 'memory'], 8_000);
  if (mem) inv.memory_modules = parseDmidecodeMemory(mem);
  inv.network_adapters = parseIpJson(await out('ip', ['-j', 'addr'], 8_000));
  const tpmVersion = readFile('/sys/class/tpm/tpm0/tpm_version_major');
  if (tpmVersion) inv.security.push(sec('TPM-Spezifikation', `${tpmVersion}.0`, 'info'));
}

// ───────────────────────────── macOS ─────────────────────────────

/** `ifconfig`-Ausgabe → Netzwerkverbindungen (nur enX-Schnittstellen mit MAC-Adresse). */
export function parseIfconfig(text: string): NonNullable<MachineInventory['network_adapters']> {
  const result: NonNullable<MachineInventory['network_adapters']> = [];
  for (const block of text.split(/\n(?=\S)/)) {
    const name = /^([a-z0-9]+):/.exec(block)?.[1];
    const mac = /\sether\s+([0-9a-f:]{17})/i.exec(block)?.[1];
    if (!name || !mac || !/^en\d+$/.test(name)) continue;
    result.push({
      name, mac,
      ipv4: [...block.matchAll(/\sinet\s+([\d.]+)/g)].map((m) => m[1]!),
      ipv6: [...block.matchAll(/\sinet6\s+([0-9a-f:]+)/gi)].map((m) => m[1]!),
      connected: /status:\s*active/.test(block),
    });
  }
  return result.slice(0, 20);
}

async function macDetails(inv: MachineInventory): Promise<void> {
  const brand = await out('sysctl', ['-n', 'machdep.cpu.brand_string'], 5_000);
  const cores = Number(await out('sysctl', ['-n', 'hw.physicalcpu'], 5_000)) || null;
  const threads = Number(await out('sysctl', ['-n', 'hw.logicalcpu'], 5_000)) || null;
  const hz = Number(await out('sysctl', ['-n', 'hw.cpufrequency_max'], 5_000)) || 0; // fehlt auf Apple Silicon
  const l2 = Number(await out('sysctl', ['-n', 'hw.l2cachesize'], 5_000)) || 0;
  inv.cpu = {
    name: clean(brand) ?? inv.device.processor ?? null, manufacturer: /Apple/i.test(brand || inv.device.processor || '') ? 'Apple' : clean(await out('sysctl', ['-n', 'machdep.cpu.vendor'], 5_000)),
    description: null, cores, threads, speed_ghz: hz ? Math.round(hz / 1e8) / 10 : null, data_width: 64,
    l2_cache_kb: l2 ? Math.round(l2 / 1024) : null, architecture: os.arch(),
  };
  const hwJson = await out('system_profiler', ['SPHardwareDataType', '-json'], 30_000);
  try {
    const hw = (JSON.parse(hwJson) as { SPHardwareDataType?: Array<Record<string, string>> }).SPHardwareDataType?.[0];
    inv.bios_info = { manufacturer: 'Apple', serial: clean(hw?.serial_number), smbios_version: null, version: clean(hw?.boot_rom_version), release_date: null, software_id: clean(hw?.machine_model) };
  } catch {
    /* leer lassen */
  }
  const memJson = await out('system_profiler', ['SPMemoryDataType', '-json'], 30_000);
  try {
    const m = (JSON.parse(memJson) as { SPMemoryDataType?: Array<Record<string, any>> }).SPMemoryDataType ?? [];
    const modules: NonNullable<MachineInventory['memory_modules']> = [];
    for (const entry of m) {
      const items = Array.isArray(entry._items) ? entry._items : [];
      for (const it of items) {
        const size = /([\d.]+)\s*GB/i.exec(String(it.dimm_size ?? ''));
        if (!size) continue;
        const speed = /(\d+)/.exec(String(it.dimm_speed ?? ''));
        modules.push({ manufacturer: clean(it.dimm_manufacturer), capacity_gb: Number(size[1]), part_number: clean(it.dimm_part_number), locator: clean(it._name), form_factor: clean(it.dimm_type), speed_mhz: speed ? Number(speed[1]) : null });
      }
      // Apple Silicon: ein gemeinsamer Arbeitsspeicher statt Steckplätze
      if (!items.length && entry.SPMemoryDataType) {
        const size = /([\d.]+)\s*GB/i.exec(String(entry.SPMemoryDataType));
        if (size) modules.push({ manufacturer: clean(entry.dimm_manufacturer) ?? 'Apple', capacity_gb: Number(size[1]), part_number: null, locator: 'Unified Memory', form_factor: clean(entry.dimm_type), speed_mhz: null });
      }
    }
    inv.memory_modules = modules.slice(0, 64);
  } catch {
    /* leer lassen */
  }
  inv.network_adapters = parseIfconfig(await out('ifconfig', [], 8_000));
}

async function mac(inv: MachineInventory): Promise<void> {
  const sp = await out('system_profiler', ['SPHardwareDataType', '-json'], 30_000);
  try {
    const hw = (JSON.parse(sp) as { SPHardwareDataType?: Array<Record<string, string>> }).SPHardwareDataType?.[0];
    if (hw) {
      inv.device.manufacturer = 'Apple';
      inv.device.model = clean(hw.machine_name ? `${hw.machine_name}${hw.machine_model ? ` (${hw.machine_model})` : ''}` : hw.machine_model);
      inv.device.version = clean(hw.model_number);
      inv.device.serial = clean(hw.serial_number);
      inv.device.processor = clean(hw.chip_type ?? hw.cpu_type) ?? inv.device.processor;
      inv.device.bios = clean(hw.boot_rom_version);
      const mem = /([\d.]+)\s*GB/i.exec(hw.physical_memory ?? '');
      if (mem) inv.device.ram_gb = Number(mem[1]);
    }
  } catch {
    /* Hardware-Details bleiben leer */
  }
  inv.os.name = clean(`${await out('sw_vers', ['-productName'], 5_000)} ${await out('sw_vers', ['-productVersion'], 5_000)}`.trim());
  inv.os.version = clean(await out('sw_vers', ['-productVersion'], 5_000));
  inv.os.build = clean(await out('sw_vers', ['-buildVersion'], 5_000));
  const lang = await out('defaults', ['read', '-g', 'AppleLocale'], 5_000);
  if (lang) inv.os.language = lang;

  // df liefert unter macOS 512-Byte-Blöcke; nur die Systemvolumes mit echtem Mountpunkt
  const df = await out('df', ['-k']);
  for (const line of df.split('\n').slice(1)) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\d+\s+\d+\s+\S+\s+(\/.*)$/.exec(line.trim());
    if (!m || !m[1]!.startsWith('/dev/') || /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)/.test(m[5]!)) continue;
    inv.disks.push({ name: m[5]!, label: m[1]!, total_gb: gb(Number(m[2]) * 1024), free_gb: gb(Number(m[4]) * 1024) });
  }
  inv.disks = inv.disks.slice(0, 10);

  const fv = await out('fdesetup', ['status'], 8_000);
  inv.security.push(fv ? yesNo('FileVault (Verschlüsselung)', /On/i.test(fv) && !/Off/i.test(fv), true, 'Ein', 'Aus') : sec('FileVault (Verschlüsselung)', 'Unbekannt', 'unknown'));
  const fw = await out('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], 8_000);
  inv.security.push(fw ? yesNo('Firewall', /enabled/i.test(fw) && !/disabled/i.test(fw), true, 'Aktiviert', 'Deaktiviert') : sec('Firewall', 'Unbekannt', 'unknown'));
  const sip = await out('csrutil', ['status'], 8_000);
  inv.security.push(sip ? yesNo('Systemintegritätsschutz (SIP)', /enabled/i.test(sip), true, 'Aktiviert', 'Deaktiviert') : sec('Systemintegritätsschutz (SIP)', 'Unbekannt', 'unknown'));
  const gk = await out('spctl', ['--status'], 8_000);
  inv.security.push(gk ? yesNo('Gatekeeper', /enabled/i.test(gk), true, 'Aktiviert', 'Deaktiviert') : sec('Gatekeeper', 'Unbekannt', 'unknown'));
  await macDetails(inv);
}

// ───────────────────────────── Windows ─────────────────────────────

/** PowerShell-Skript: liefert ein JSON-Objekt; jede Sonde ist in try/catch, fehlende Rechte ergeben null. */
const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Try-Get([scriptblock]$b) { try { & $b } catch { $null } }
$cs = Get-CimInstance Win32_ComputerSystem
$csp = Get-CimInstance Win32_ComputerSystemProduct
$bios = Get-CimInstance Win32_BIOS
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cv = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ name = $_.DeviceID; label = $_.VolumeName; total = [double]$_.Size; free = [double]$_.FreeSpace } })
$sb = Try-Get { $v = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State').UEFISecureBootEnabled; if ($null -eq $v) { $null } else { [bool]$v } }
$fw = Try-Get { @(Get-NetFirewallProfile | ForEach-Object { [bool]$_.Enabled }) }
$enc = Try-Get { $p = (New-Object -ComObject Shell.Application).NameSpace($env:SystemDrive).Self.ExtendedProperty('System.Volume.BitLockerProtection'); if ($null -eq $p) { $null } else { [int]$p } }
$av = Try-Get { @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntivirusProduct | ForEach-Object { $_.displayName }) }
$mp = Try-Get { Get-MpComputerStatus }
$tpm = Try-Get { [bool](@(Get-PnpDevice -Class SecurityDevices | Where-Object { $_.FriendlyName -match 'Trusted Platform Module' -and $_.Status -eq 'OK' }).Count -gt 0) }
$uac = Try-Get { (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System').EnableLUA }
$wuSvc = Try-Get { (Get-Service wuauserv).StartType.ToString() }
$pending = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
$mem = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ manufacturer = $_.Manufacturer; capacity = [double]$_.Capacity; part = $_.PartNumber; locator = $_.DeviceLocator; form = [int]$_.FormFactor; speed = [int]$_.Speed } })
$net = @(Try-Get { Get-NetAdapter -Physical | ForEach-Object { $ips = @(Get-NetIPAddress -InterfaceIndex $_.ifIndex); @{ name = $_.InterfaceDescription; mac = $_.MacAddress; up = ($_.Status -eq 'Up'); v4 = @($ips | Where-Object { $_.AddressFamily -eq 'IPv4' } | ForEach-Object { $_.IPAddress }); v6 = @($ips | Where-Object { $_.AddressFamily -eq 'IPv6' } | ForEach-Object { $_.IPAddress }) } } })
$tpmDev = Try-Get { Get-PnpDevice -Class SecurityDevices | Where-Object { $_.FriendlyName -match 'Trusted Platform Module' } | Select-Object -First 1 }
$tpmIds = if ($tpmDev) { Try-Get { (Get-PnpDeviceProperty -InstanceId $tpmDev.InstanceId -KeyName 'DEVPKEY_Device_HardwareIds').Data -join ',' } } else { $null }
$extra = @{
  cpuInfo = @{ name = $cpu.Name; manufacturer = $cpu.Manufacturer; description = $cpu.Description; cores = [int]$cpu.NumberOfCores; threads = [int]$cpu.NumberOfLogicalProcessors; mhz = [int]$cpu.MaxClockSpeed; width = [int]$cpu.DataWidth; l2 = [int]$cpu.L2CacheSize; arch = [int]$cpu.Architecture }
  biosInfo = @{ manufacturer = $bios.Manufacturer; serial = $bios.SerialNumber; smbios = $bios.SMBIOSBIOSVersion; version = $bios.Version; date = $bios.ReleaseDate.ToString('yyyy-MM-dd'); softwareId = $bios.SoftwareElementID }
  memory = $mem; nics = $net; tpmName = $tpmDev.FriendlyName; tpmIds = $tpmIds
}
@{
  extra = $extra
  manufacturer = $cs.Manufacturer; model = $cs.Model; version = $csp.Version; serial = $bios.SerialNumber
  processor = $cpu.Name
  ram = [double]$cs.TotalPhysicalMemory
  bios = "$($bios.Manufacturer) - $($bios.SMBIOSBIOSVersion) / $($bios.ReleaseDate.ToString('yyyy-MM-dd'))"
  osName = $os.Caption; osVersion = "$($cv.DisplayVersion) $($os.Version).$($cv.UBR)"; osBuild = $os.BuildNumber
  language = (Get-Culture).Name
  disks = $disks; secureBoot = $sb; firewall = $fw; encryption = $enc; av = $av
  mpAv = if ($mp) { @{ enabled = [bool]$mp.AntivirusEnabled; realtime = [bool]$mp.RealTimeProtectionEnabled; sigAge = [int]$mp.AntivirusSignatureAge; spyEnabled = [bool]$mp.AntispywareEnabled; spyAge = [int]$mp.AntispywareSignatureAge } } else { $null }
  tpm = $tpm; uac = $uac; wuService = $wuSvc; rebootPending = $pending
} | ConvertTo-Json -Depth 5 -Compress
`;

interface WinRaw {
  manufacturer?: string; model?: string; version?: string; serial?: string; processor?: string; ram?: number; bios?: string;
  osName?: string; osVersion?: string; osBuild?: string; language?: string;
  disks?: Array<{ name: string; label?: string; total: number; free: number }> | { name: string; label?: string; total: number; free: number };
  secureBoot?: boolean | null; firewall?: boolean[] | boolean | null; encryption?: number | null; av?: string[] | string | null;
  mpAv?: { enabled: boolean; realtime: boolean; sigAge: number; spyEnabled: boolean; spyAge: number } | null;
  tpm?: boolean | null; uac?: number | null; wuService?: string | null; rebootPending?: boolean;
  extra?: {
    cpuInfo?: { name?: string; manufacturer?: string; description?: string; cores?: number; threads?: number; mhz?: number; width?: number; l2?: number; arch?: number };
    biosInfo?: { manufacturer?: string; serial?: string; smbios?: string; version?: string; date?: string; softwareId?: string };
    memory?: Array<{ manufacturer?: string; capacity: number; part?: string; locator?: string; form?: number; speed?: number }> | { manufacturer?: string; capacity: number; part?: string; locator?: string; form?: number; speed?: number };
    nics?: Array<{ name: string; mac?: string; up?: boolean; v4?: string[] | string; v6?: string[] | string }> | { name: string; mac?: string; up?: boolean; v4?: string[] | string; v6?: string[] | string };
    tpmName?: string | null; tpmIds?: string | null;
  };
}

const WIN_ARCH: Record<number, string> = { 0: 'x86', 5: 'ARM', 9: 'x64', 12: 'ARM64' };
const WIN_FORM: Record<number, string> = { 8: 'DIMM', 12: 'SODIMM', 13: 'SRIMM', 14: 'SMD', 15: 'SSMP', 16: 'QFP', 17: 'TQFP', 18: 'SOIC', 19: 'LCC', 20: 'PLCC', 21: 'BGA' };

/** PowerShell-JSON → Inventar (getrennt, damit es ohne Windows testbar ist). */
export function mapWindows(raw: WinRaw, inv: MachineInventory): void {
  const arr = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  inv.device.manufacturer = clean(raw.manufacturer);
  inv.device.model = clean(raw.model);
  inv.device.version = clean(raw.version);
  inv.device.serial = clean(raw.serial);
  inv.device.processor = clean(raw.processor?.replace(/\s+/g, ' ')) ?? inv.device.processor;
  if (raw.ram) inv.device.ram_gb = gb(raw.ram, 2);
  inv.device.bios = clean(raw.bios);
  inv.os.name = clean(raw.osName);
  inv.os.version = clean(raw.osVersion);
  inv.os.build = clean(raw.osBuild);
  inv.os.language = clean(raw.language) ?? inv.os.language;
  inv.disks = arr(raw.disks).map((d) => ({ name: d.name, label: clean(d.label), total_gb: gb(d.total), free_gb: gb(d.free) })).slice(0, 20);

  inv.security.push(raw.secureBoot == null ? sec('Secure Boot', 'Unbekannt (kein UEFI?)', 'unknown') : yesNo('Secure Boot', raw.secureBoot, true, 'Aktiviert', 'Deaktiviert'));
  const uac = raw.uac;
  inv.security.push(uac == null ? sec('Benutzerkontensteuerung (UAC)', 'Unbekannt', 'unknown') : yesNo('Benutzerkontensteuerung (UAC)', uac === 1, true, 'Aktiviert', 'Deaktiviert'));
  if (raw.mpAv) {
    const m = raw.mpAv;
    inv.security.push(sec('Virenschutz', `${arr(raw.av).join(', ') || 'Windows Defender'}: ${m.enabled && m.realtime ? 'aktiv und überwacht' : 'nicht vollständig aktiv'}`, m.enabled && m.realtime ? 'ok' : 'bad'));
    inv.security.push(sec('Virendefinitionen', m.sigAge <= 3 ? `Aktuell (${m.sigAge} Tage alt)` : `Veraltet (${m.sigAge} Tage alt)`, m.sigAge <= 3 ? 'ok' : 'warn'));
    inv.security.push(sec('Spyware-Schutz', m.spyEnabled ? 'Aktiv und überwacht' : 'Deaktiviert', m.spyEnabled ? 'ok' : 'bad'));
    inv.security.push(sec('Spyware-Definitionen', m.spyAge <= 3 ? `Aktuell (${m.spyAge} Tage alt)` : `Veraltet (${m.spyAge} Tage alt)`, m.spyAge <= 3 ? 'ok' : 'warn'));
  } else {
    const names = arr(raw.av);
    inv.security.push(names.length ? sec('Virenschutz', names.join(', '), 'ok') : sec('Virenschutz', 'Kein Produkt erkannt', 'warn'));
  }
  const fw = arr(raw.firewall);
  inv.security.push(fw.length ? yesNo('Firewall', fw.every(Boolean), true, 'Aktiviert (alle Profile)', 'Mindestens ein Profil aus') : sec('Firewall', 'Unbekannt', 'unknown'));
  inv.security.push(raw.encryption == null ? sec('Laufwerk verschlüsselt (BitLocker)', 'Unbekannt', 'unknown') : yesNo('Laufwerk verschlüsselt (BitLocker)', raw.encryption === 1, true, 'Ja', 'Nein'));
  inv.security.push(raw.tpm == null ? sec('TPM', 'Unbekannt', 'unknown') : yesNo('TPM', raw.tpm, true, 'Vorhanden', 'Nicht vorhanden'));
  if (raw.wuService) inv.security.push(sec('Windows-Update-Dienst', raw.wuService === 'Disabled' ? 'Deaktiviert' : 'Aktiviert', raw.wuService === 'Disabled' ? 'bad' : 'ok'));
  inv.security.push(raw.rebootPending ? sec('Neustart ausstehend', 'Ja (Updates)', 'warn') : sec('Neustart ausstehend', 'Nein', 'ok'));

  const x = raw.extra;
  if (x) {
    const c = x.cpuInfo;
    if (c) {
      inv.cpu = {
        name: clean(c.name?.replace(/\s+/g, ' ')), manufacturer: clean(c.manufacturer), description: clean(c.description),
        cores: c.cores || null, threads: c.threads || null, speed_ghz: c.mhz ? Math.round(c.mhz / 100) / 10 : null,
        data_width: c.width || null, l2_cache_kb: c.l2 || null, architecture: c.arch !== undefined ? (WIN_ARCH[c.arch] ?? String(c.arch)) : null,
      };
    }
    const b = x.biosInfo;
    if (b) {
      inv.bios_info = {
        manufacturer: clean(b.manufacturer), serial: clean(b.serial), smbios_version: clean(b.smbios), version: clean(b.version),
        release_date: clean(b.date), software_id: clean(b.softwareId),
      };
    }
    inv.memory_modules = arr(x.memory).map((m) => ({
      manufacturer: clean(m.manufacturer), capacity_gb: gb(m.capacity, 2), part_number: clean(m.part), locator: clean(m.locator),
      form_factor: m.form ? (WIN_FORM[m.form] ?? String(m.form)) : null, speed_mhz: m.speed || null,
    })).slice(0, 64);
    inv.network_adapters = arr(x.nics).map((n) => ({
      name: n.name, mac: clean(n.mac?.replace(/-/g, ':')), ipv4: arr(n.v4), ipv6: arr(n.v6), connected: Boolean(n.up),
    })).slice(0, 20);
    // TPM-Details ohne Adminrechte: Hersteller-Kürzel aus der Hardware-ID (ACPI\VEN_IFX), Spezifikation aus dem Gerätenamen
    const vendor = /VEN_([A-Z0-9]{3,4})/.exec(x.tpmIds ?? '')?.[1];
    if (vendor) inv.security.push(sec('TPM-Hersteller', vendor, 'info'));
    const spec = /(\d+\.\d+)\s*$/.exec(x.tpmName ?? '')?.[1];
    if (spec) inv.security.push(sec('TPM-Spezifikation', spec, 'info'));
  }
}

async function windows(inv: MachineInventory): Promise<void> {
  const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
  const json = await out('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 60_000);
  mapWindows(JSON.parse(json) as WinRaw, inv);
}

/** Sammelt das Inventar. Jede Plattform-Sonde ist best effort; Fehler lassen nur einzelne Felder leer. */
export async function collectInventory(): Promise<MachineInventory> {
  const inv = base();
  try {
    if (process.platform === 'win32') await windows(inv);
    else if (process.platform === 'darwin') await mac(inv);
    else await linux(inv);
  } catch {
    /* Basisdaten genügen */
  }
  return inv;
}
