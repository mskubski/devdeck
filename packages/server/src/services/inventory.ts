import type { InventoryLevel, MachineCustomField, MachineInventory } from '@devdeck/shared';

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : null);
const LEVELS: InventoryLevel[] = ['ok', 'warn', 'bad', 'unknown'];

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
  };
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
