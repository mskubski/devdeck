import { isHostyName, sanitizeHost, validateArchManifest, type WorkspaceFacts } from '@devdeck/shared';

const MAX_JSON = 120_000;

/**
 * Fakten eines Agenten defensiv bereinigen, bevor sie gespeichert werden (der Agent ist vertrauenswürdig,
 * aber die Daten sollen auch bei einem fehlerhaften/älteren Agenten nie Geheimnisse enthalten):
 * Hostnamen nur für Host-artige Namen und ohne Zugangsdaten, Längen begrenzt, Manifest neu validiert.
 */
export function sanitizeFacts(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const strs = (v: unknown, max: number, len: number): string[] =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, len)).slice(0, max);

  const env: WorkspaceFacts['env'] = [];
  for (const e of (Array.isArray(f.env) ? f.env : []).slice(0, 400)) {
    const name = typeof e?.name === 'string' ? e.name.slice(0, 80) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const host = typeof e.host === 'string' && isHostyName(name) ? sanitizeHost(e.host) : null;
    env.push(host ? { name, host } : { name });
  }
  const databases: WorkspaceFacts['databases'] = [];
  for (const d of (Array.isArray(f.databases) ? f.databases : []).slice(0, 20)) {
    if (typeof d?.path === 'string' && Number.isFinite(Number(d.bytes))) {
      databases.push({ kind: 'sqlite', path: d.path.slice(0, 200), bytes: Math.max(0, Math.floor(Number(d.bytes))) });
    }
  }
  const validated = f.architecture ? validateArchManifest(f.architecture) : { manifest: null, error: null };
  const facts: WorkspaceFacts = {
    env,
    markers: strs(f.markers, 40, 80),
    packages: strs(f.packages, 400, 80),
    databases,
    architecture: validated.manifest,
    architecture_error:
      validated.error ?? (typeof f.architecture_error === 'string' ? f.architecture_error.slice(0, 300) : null),
    collected_at: typeof f.collected_at === 'string' ? f.collected_at.slice(0, 40) : new Date().toISOString(),
  };
  const json = JSON.stringify(facts);
  return json.length > MAX_JSON ? null : json;
}
