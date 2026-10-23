import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isHostyName, sanitizeHost, validateArchManifest, type WorkspaceFacts } from '@devdeck/shared';

const ENV_REAL = ['.env', '.env.local', '.env.production', '.env.staging', '.env.development'];
const ENV_EXAMPLE = ['.env.example', '.env.sample', '.env.template'];
const MARKERS = [
  'vercel.json', '.vercel/project.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'Procfile', 'wrangler.toml',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml', 'supabase/config.toml',
  'ecosystem.config.js', 'serverless.yml',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build', '.next', 'site-packages']);
const MAX_FILE = 512 * 1024;

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Variablennamen (und bei Host-artigen Namen den bereinigten Hostnamen) – nie andere Werte. */
function collectEnv(root: string): WorkspaceFacts['env'] {
  const byName = new Map<string, string | undefined>();
  const read = (file: string, allowHost: boolean): void => {
    const text = readSmall(path.join(root, file));
    if (text === null) return;
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
      if (!m || raw.trim().startsWith('#')) continue;
      const name = m[1]!;
      let host: string | undefined;
      if (allowHost && isHostyName(name)) host = sanitizeHost(m[2]!.replace(/\s+#.*$/, '')) ?? undefined;
      if (!byName.has(name) || (!byName.get(name) && host)) byName.set(name, host);
    }
  };
  for (const f of ENV_REAL) read(f, true);
  for (const f of ENV_EXAMPLE) read(f, false); // Beispieldateien enthalten Platzhalter – nur Namen
  return [...byName].slice(0, 400).map(([name, host]) => (host ? { name, host } : { name }));
}

function collectPackages(root: string): string[] {
  const names = new Set<string>();
  const pkg = readSmall(path.join(root, 'package.json'));
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>;
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const n of Object.keys(j[key] ?? {})) names.add(n.toLowerCase());
      }
    } catch {
      /* kaputtes package.json ignorieren */
    }
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    /* ignorieren */
  }
  for (const f of entries.filter((e) => /^requirements.*\.txt$/i.test(e))) {
    for (const line of (readSmall(path.join(root, f)) ?? '').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) names.add(m[1]!.toLowerCase().replace(/_/g, '-'));
    }
  }
  const pyproject = readSmall(path.join(root, 'pyproject.toml'));
  if (pyproject) {
    for (const m of pyproject.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~\[;].*)?["']/g)) {
      names.add(m[1]!.toLowerCase().replace(/_/g, '-'));
    }
  }
  return [...names].slice(0, 400);
}

function collectDatabases(root: string): WorkspaceFacts['databases'] {
  const out: WorkspaceFacts['databases'] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.length >= 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && /\.(db|sqlite|sqlite3)$/i.test(e.name)) {
        try {
          out.push({ kind: 'sqlite', path: path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'), bytes: fs.statSync(path.join(dir, e.name)).size });
        } catch {
          /* Datei verschwunden */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

function collectMarkers(root: string): string[] {
  const found = MARKERS.filter((m) => fs.existsSync(path.join(root, m)));
  // systemd-Units im Repo (z. B. deploy/systemd/*.service)
  const hasService = (dir: string, depth: number): boolean => {
    if (depth > 3) return false;
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).some((e) =>
        e.isDirectory() ? !SKIP_DIRS.has(e.name) && hasService(path.join(dir, e.name), depth + 1) : /\.service$/.test(e.name));
    } catch {
      return false;
    }
  };
  if (hasService(root, 0)) found.push('systemd');
  return found;
}

function collectManifest(root: string): { architecture: WorkspaceFacts['architecture']; error: string | null } {
  for (const name of ['architecture.yaml', 'architecture.yml']) {
    const text = readSmall(path.join(root, '.devdeck', name));
    if (text === null) continue;
    try {
      const { manifest, error } = validateArchManifest(YAML.parse(text));
      return { architecture: manifest, error: error ? `.devdeck/${name}: ${error}` : null };
    } catch (err) {
      return { architecture: null, error: `.devdeck/${name}: YAML nicht lesbar (${err instanceof Error ? err.message.split('\n')[0] : 'Fehler'})` };
    }
  }
  return { architecture: null, error: null };
}

/** Fakten für die Architektur-Karte sammeln. Liest nur Namen, Dateigrößen und bereinigte Hostnamen. */
export function collectFacts(workspacePath: string): WorkspaceFacts {
  const manifest = collectManifest(workspacePath);
  return {
    env: collectEnv(workspacePath),
    markers: collectMarkers(workspacePath),
    packages: collectPackages(workspacePath),
    databases: collectDatabases(workspacePath),
    architecture: manifest.architecture,
    architecture_error: manifest.error,
    collected_at: new Date().toISOString(),
  };
}
