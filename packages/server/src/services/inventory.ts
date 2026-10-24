import type { InventoryLevel, MachineApplication, MachineCustomField, MachineInventory } from '@devdeck/shared';

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : null);
const LEVELS: InventoryLevel[] = ['ok', 'warn', 'bad', 'info', 'unknown'];

/**
 * Inventar vom Agenten nur in der bekannten Form übernehmen: feste Schlüssel, begrenzte Längen und Anzahlen.
 * Der Agent sendet nur Metadaten (keine Geheimnisse); trotzdem wird nichts Unbekanntes gespeichert.
 */
export function sanitizeInventory(raw: unknown): MachineInventory | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const d = obj(r.device);
  const o = obj(r.os);
  const rt = obj(r.runtime);
  const ips = Array.isArray(obj(r.network).ips) ? (obj(r.network).ips as unknown[]) : [];
  return {
    collected_at: str(r.collected_at, 40) ?? new Date().toISOString(),
    platform: str(r.platform, 20) ?? 'unknown',
    hostname: str(r.hostname, 100),
    user: str(r.user, 100),
    device: {
      manufacturer: str(d.manufacturer),
      model: str(d.model),
      version: str(d.version),
      processor: str(d.processor),
      serial: str(d.serial, 100),
      ram_gb: num(d.ram_gb),
      bios: str(d.bios),
    },
    os: {
      name: str(o.name),
      version: str(o.version),
      build: str(o.build, 60),
      language: str(o.language, 40),
      arch: str(o.arch, 40),
      kernel: str(o.kernel, 100),
    },
    disks: (Array.isArray(r.disks) ? r.disks : []).slice(0, 20).flatMap((x: any) => {
      const name = str(x?.name, 120);
      const total = num(x?.total_gb);
      const free = num(x?.free_gb);
      return name && total !== null && free !== null ? [{ name, label: str(x.label, 120), total_gb: total, free_gb: free }] : [];
    }),
    security: (Array.isArray(r.security) ? r.security : []).slice(0, 30).flatMap((x: any) => {
      const label = str(x?.label, 100);
      const value = str(x?.value, 200);
      return label && value ? [{ label, value, level: LEVELS.includes(x.level) ? (x.level as InventoryLevel) : 'unknown' }] : [];
    }),
    network: { ips: ips.map((i) => str(i, 60)).filter((i): i is string => i !== null).slice(0, 10) },
    runtime: { boot_time: str(rt.boot_time, 40), node: str(rt.node, 40) },
    cpu: sanitizeCpu(r.cpu),
    bios_info: sanitizeBios(r.bios_info),
    memory_modules: (Array.isArray(r.memory_modules) ? r.memory_modules : []).slice(0, 64).flatMap((m: any) => {
      const capacity = num(m?.capacity_gb);
      return capacity !== null
        ? [{ manufacturer: str(m.manufacturer, 80), capacity_gb: capacity, part_number: str(m.part_number, 80), locator: str(m.locator, 80), form_factor: str(m.form_factor, 40), speed_mhz: num(m.speed_mhz) }]
        : [];
    }),
    network_adapters: (Array.isArray(r.network_adapters) ? r.network_adapters : []).slice(0, 20).flatMap((n: any) => {
      const name = str(n?.name, 150);
      const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => str(x, 80)).filter((x): x is string => x !== null).slice(0, 10);
      return name ? [{ name, mac: str(n.mac, 40), ipv4: list(n.ipv4), ipv6: list(n.ipv6), connected: n.connected === true }] : [];
    }),
  };
}

function sanitizeCpu(raw: unknown): MachineInventory['cpu'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  return {
    name: str(c.name), manufacturer: str(c.manufacturer, 80), description: str(c.description), cores: num(c.cores), threads: num(c.threads),
    speed_ghz: num(c.speed_ghz), data_width: num(c.data_width), l2_cache_kb: num(c.l2_cache_kb), architecture: str(c.architecture, 40),
  };
}

function sanitizeBios(raw: unknown): MachineInventory['bios_info'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  return {
    manufacturer: str(b.manufacturer, 80), serial: str(b.serial, 100), smbios_version: str(b.smbios_version), version: str(b.version),
    release_date: str(b.release_date, 40), software_id: str(b.software_id),
  };
}

/** Höchstzahl gespeicherter Programme je Maschine (Linux-Paketlisten können lang sein). */
export const MAX_APPLICATIONS = 2500;

/** Software-Liste nur in der bekannten Form übernehmen: begrenzte Längen und Anzahl. */
export function sanitizeApplications(raw: unknown): MachineApplication[] | null {
  const items = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(items)) return null;
  const result: MachineApplication[] = [];
  for (const a of items) {
    if (result.length >= MAX_APPLICATIONS) break;
    const name = str((a as any)?.name, 150);
    if (!name) continue;
    result.push({
      name,
      version: str((a as any).version, 60),
      publisher: str((a as any).publisher, 100),
      identifier: str((a as any).identifier, 120),
      source: str((a as any).source, 50) ?? 'Unbekannt',
    });
  }
  return result;
}

/** Freie Felder (Label/Wert) prüfen und normalisieren. */
export function sanitizeCustomFields(raw: unknown): MachineCustomField[] | null {
  if (!Array.isArray(raw) || raw.length > 30) return null;
  const fields: MachineCustomField[] = [];
  for (const f of raw) {
    const label = str((f as any)?.label, 60);
    const value = str((f as any)?.value, 500) ?? '';
    if (label) fields.push({ label, value });
  }
  return fields;
}
