/**
 * Architektur-Karte eines Projekts: Komponenten (Entwicklung, Repository, Hosting, Datenbank, externe Dienste)
 * und ihre Beziehungen. Gemeinsame Typen + reine Hilfsfunktionen für Agent (Fakten sammeln) und Server (auswerten).
 */

export const ARCH_KINDS = [
  'dev', 'repo', 'hosting', 'database', 'storage', 'service', 'llm', 'mail', 'messaging', 'map', 'payment', 'other',
] as const;
export type ArchKind = (typeof ARCH_KINDS)[number];

export function isArchKind(v: unknown): v is ArchKind {
  return typeof v === 'string' && (ARCH_KINDS as readonly string[]).includes(v);
}

export type ArchSource = 'auto' | 'manifest' | 'manual';

export interface ArchDetail {
  label: string;
  value: string;
}

export interface ArchComponent {
  key: string;
  kind: ArchKind;
  name: string;
  provider: string | null;
  description: string | null;
  details: ArchDetail[];
  source: ArchSource;
  /** Ampelfarbe, falls bekannt */
  status?: 'ok' | 'warn' | 'bad' | 'unknown';
  /** Platzhalter für etwas, das noch festgelegt werden sollte (gestrichelt dargestellt) */
  placeholder?: boolean;
}

export interface ArchLink {
  id: string;
  from: string;
  to: string;
  label: string;
  description: string | null;
  source: ArchSource;
  dashed?: boolean;
}

export interface ArchModel {
  components: ArchComponent[];
  links: ArchLink[];
  /** Zeitpunkt der letzten Fakten-Erhebung durch einen Agenten (ISO) */
  facts_at: string | null;
  manifest: { present: boolean; error: string | null };
  /** Ausgeblendete Elemente (wiederherstellbar) */
  hidden: { components: Array<{ key: string; name: string }>; links: Array<{ from: string; to: string; label: string }> };
}

/** Vom Agenten aus einem Workspace gesammelte Fakten (nur Namen/Hosts, nie Geheimnisse). */
export interface WorkspaceFacts {
  /** Variablennamen aus .env*-Dateien; `host` nur für Host-/URL-artige Variablen, ohne Zugangsdaten */
  env: Array<{ name: string; host?: string }>;
  /** Dateien/Verzeichnisse, die auf Hosting/Deployment hindeuten (vercel.json, Dockerfile, …) */
  markers: string[];
  /** Namen der Abhängigkeiten (package.json, requirements.txt, pyproject.toml) */
  packages: string[];
  /** Lokale SQLite-Dateien mit Größe */
  databases: Array<{ kind: 'sqlite'; path: string; bytes: number }>;
  /** Geparstes und validiertes `.devdeck/architecture.yaml` (oder null) */
  architecture: ArchManifest | null;
  architecture_error: string | null;
  collected_at: string;
}

export interface ArchManifestComponent {
  id: string;
  kind: ArchKind;
  name: string;
  provider?: string;
  description?: string;
  details?: Record<string, string>;
}

export interface ArchManifestLink {
  from: string;
  to: string;
  label: string;
  description?: string;
}

export interface ArchManifest {
  version: 1;
  components: ArchManifestComponent[];
  links: ArchManifestLink[];
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|AUTH|CREDENTIAL|PRIVATE|SALT|COOKIE)/i;
const HOSTY_NAME = /(^|_)(HOST|HOSTNAME|URL|URI|ENDPOINT|DOMAIN|REGION|SERVER|BASE)(_|$)/i;

export function isSecretLikeName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Variablen, deren Wert (als Hostname) angezeigt werden darf: host-artiger Name und nicht secret-artig. */
export function isHostyName(name: string): boolean {
  return HOSTY_NAME.test(name) && !SECRET_NAME.test(name.replace(/(^|_)(URL|URI)(_|$)/i, '_'));
}

/**
 * Aus einem Variablenwert nur den Hostnamen übernehmen (ohne Schema, Zugangsdaten, Port, Pfad, Query).
 * Gibt null zurück, wenn der Wert nicht wie ein Host/eine URL aussieht (z. B. ein Token).
 */
export function sanitizeHost(value: string): string | null {
  const v = value.trim().replace(/^['"]|['"]$/g, '');
  if (!v || v.length > 255) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `x://${v}`;
  try {
    const u = new URL(withScheme);
    const host = u.hostname.toLowerCase();
    if (!host || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
    // Hostnamen ohne Punkt sind nur für localhost sinnvoll; sonst ist es meist kein Host (Wort, Modellname, …)
    if (!host.includes('.') && host !== 'localhost') return null;
    return host;
  } catch {
    return null;
  }
}

/** Prüft ein geparstes `.devdeck/architecture.yaml` und liefert eine bereinigte Fassung oder eine Fehlermeldung. */
export function validateArchManifest(raw: unknown): { manifest: ArchManifest | null; error: string | null } {
  if (!raw || typeof raw !== 'object') return { manifest: null, error: 'Datei ist leer oder kein YAML-Objekt' };
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return { manifest: null, error: 'version: 1 erwartet' };
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  const components: ArchManifestComponent[] = [];
  const ids = new Set<string>();
  for (const [i, c] of (Array.isArray(obj.components) ? obj.components : []).entries()) {
    const comp = (c ?? {}) as Record<string, unknown>;
    const id = str(comp.id, 60);
    const name = str(comp.name, 120);
    if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id)) return { manifest: null, error: `components[${i}]: id fehlt oder enthält ungültige Zeichen` };
    if (!name) return { manifest: null, error: `components[${i}] (${id}): name fehlt` };
    if (!isArchKind(comp.kind)) return { manifest: null, error: `components[${i}] (${id}): kind muss einer von ${ARCH_KINDS.join(', ')} sein` };
    if (ids.has(id)) return { manifest: null, error: `components: id "${id}" doppelt` };
    ids.add(id);
    const details: Record<string, string> = {};
    if (comp.details && typeof comp.details === 'object') {
      for (const [k, v] of Object.entries(comp.details as Record<string, unknown>).slice(0, 12)) {
        if (typeof v === 'string' || typeof v === 'number') details[k.slice(0, 40)] = String(v).slice(0, 200);
      }
    }
    components.push({
      id, kind: comp.kind, name,
      ...(str(comp.provider, 120) ? { provider: str(comp.provider, 120)! } : {}),
      ...(str(comp.description, 600) ? { description: str(comp.description, 600)! } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    });
  }
  const links: ArchManifestLink[] = [];
  for (const [i, l] of (Array.isArray(obj.links) ? obj.links : []).entries()) {
    const link = (l ?? {}) as Record<string, unknown>;
    const from = str(link.from, 60);
    const to = str(link.to, 60);
    const label = str(link.label, 80);
    if (!from || !to || !label) return { manifest: null, error: `links[${i}]: from, to und label sind Pflicht` };
    links.push({ from, to, label, ...(str(link.description, 400) ? { description: str(link.description, 400)! } : {}) });
  }
  if (components.length > 80 || links.length > 200) return { manifest: null, error: 'Zu viele Komponenten/Beziehungen' };
  return { manifest: { version: 1, components, links }, error: null };
}
