import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { parse } from 'yaml';

/**
 * `.devdeck/workspace.yaml` – versionskontrolliertes Workspace-Manifest (Spezifikation §11).
 * Enthält NIEMALS Secret-Werte. Ausgelegt auf zusätzliche Runtime-/Tool-Typen.
 */
export interface WorkspaceManifest {
  version: number;
  project: { name: string };
  runtime?: Record<string, string>;
  package_manager?: { type: string; install: string };
  services?: Record<string, boolean>;
  mobile?: { android?: boolean; ios?: boolean };
  environment?: { source: string; target: string };
  tools?: string[];
  deploy?: DeployConfig;
}

/** Ein systemd-Benutzerdienst, der beim Deploy neu gestartet und danach geprüft wird. */
export interface DeployService {
  unit: string;
  /** Nur http(s) auf localhost; Antwort 2xx = gesund. Ohne Angabe wird `systemctl --user is-active` geprüft. */
  health_url?: string;
}

/** Deploy-Konfiguration eines Workspaces (Produktivbetrieb auf dieser Maschine, Linux/systemd --user). */
export interface DeployConfig {
  services: DeployService[];
  /** Optionaler Installationsbefehl nach neuem Code (z. B. `.venv/bin/pip install -r requirements.txt`), ohne Shell. */
  install?: string;
  /** So lange wartet der Deploy auf gesunde Dienste (Sekunden). */
  timeout_seconds: number;
}

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,99}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseDeploy(raw: unknown): DeployConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('MANIFEST_INVALID', 'deploy muss eine Map sein');
  }
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.services) || d.services.length === 0 || d.services.length > 10) {
    throw new AppError('MANIFEST_INVALID', 'deploy.services braucht 1–10 Einträge');
  }
  const services: DeployService[] = d.services.map((entry) => {
    const s = (typeof entry === 'string' ? { unit: entry } : entry) as Record<string, unknown> | null;
    if (!s || typeof s.unit !== 'string' || !UNIT_RE.test(s.unit)) {
      throw new AppError('MANIFEST_INVALID', 'deploy.services[].unit ist kein gültiger systemd-Unit-Name');
    }
    const service: DeployService = { unit: s.unit };
    if (s.health_url !== undefined) {
      let url: URL;
      try {
        url = new URL(String(s.health_url));
      } catch {
        throw new AppError('MANIFEST_INVALID', `deploy.services[].health_url ist keine gültige URL (${s.unit})`);
      }
      if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
        throw new AppError('MANIFEST_INVALID', `health_url darf nur http(s) auf localhost zeigen (${s.unit})`);
      }
      service.health_url = url.toString();
    }
    return service;
  });
  const config: DeployConfig = { services, timeout_seconds: 60 };
  if (d.timeout_seconds !== undefined) {
    const t = Number(d.timeout_seconds);
    if (!Number.isFinite(t) || t < 5 || t > 600) {
      throw new AppError('MANIFEST_INVALID', 'deploy.timeout_seconds muss zwischen 5 und 600 liegen');
    }
    config.timeout_seconds = Math.round(t);
  }
  if (d.install !== undefined) {
    if (typeof d.install !== 'string' || d.install.trim() === '' || /[;&|`$><]/.test(d.install)) {
      throw new AppError('MANIFEST_INVALID', 'deploy.install ist leer oder enthält unzulässige Zeichen');
    }
    config.install = d.install.trim();
  }
  return config;
}

export function parseManifest(text: string): WorkspaceManifest {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new AppError('MANIFEST_INVALID', `workspace.yaml ist kein gültiges YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AppError('MANIFEST_INVALID', 'workspace.yaml muss eine YAML-Map sein');
  }
  const raw = doc as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== '1') {
    throw new AppError('MANIFEST_INVALID', 'Nur Manifest-Version 1 wird unterstützt');
  }
  const project = raw.project as Record<string, unknown> | undefined;
  if (!project || typeof project.name !== 'string' || project.name.trim() === '') {
    throw new AppError('MANIFEST_INVALID', 'project.name fehlt');
  }

  const manifest: WorkspaceManifest = {
    version: 1,
    project: { name: project.name.trim() },
  };
  if (raw.runtime && typeof raw.runtime === 'object' && !Array.isArray(raw.runtime)) {
    manifest.runtime = Object.fromEntries(
      Object.entries(raw.runtime as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  if (raw.package_manager && typeof raw.package_manager === 'object') {
    const pm = raw.package_manager as Record<string, unknown>;
    if (typeof pm.type !== 'string' || typeof pm.install !== 'string') {
      throw new AppError('MANIFEST_INVALID', 'package_manager benötigt type und install');
    }
    // Keine Shell-Metazeichen in Installationsbefehlen erlauben
    if (/[;&|`$><]/.test(pm.install)) {
      throw new AppError('MANIFEST_INVALID', 'package_manager.install enthält unzulässige Zeichen');
    }
    manifest.package_manager = { type: pm.type, install: pm.install };
  }
  if (raw.services && typeof raw.services === 'object' && !Array.isArray(raw.services)) {
    manifest.services = Object.fromEntries(
      Object.entries(raw.services as Record<string, unknown>).map(([k, v]) => [k, Boolean(v)]),
    );
  }
  if (raw.mobile && typeof raw.mobile === 'object') {
    const mobile = raw.mobile as Record<string, unknown>;
    manifest.mobile = { android: Boolean(mobile.android), ios: Boolean(mobile.ios) };
  }
  if (raw.environment && typeof raw.environment === 'object') {
    const env = raw.environment as Record<string, unknown>;
    if (typeof env.target === 'string' && path.basename(env.target) !== env.target) {
      throw new AppError('MANIFEST_INVALID', 'environment.target muss ein Dateiname sein (z. B. .env)');
    }
    manifest.environment = {
      source: typeof env.source === 'string' ? env.source : 'devdeck',
      target: typeof env.target === 'string' ? env.target : '.env',
    };
  }
  if (Array.isArray(raw.tools)) {
    manifest.tools = raw.tools.map((t) => String(t)).filter((t) => /^[a-z0-9._-]+$/i.test(t));
  }
  if (raw.deploy !== undefined && raw.deploy !== null) manifest.deploy = parseDeploy(raw.deploy);
  return manifest;
}

export function manifestPath(workspacePath: string): string {
  return path.join(workspacePath, '.devdeck', 'workspace.yaml');
}

/** Manifest laden; null wenn nicht vorhanden. */
export function loadManifest(workspacePath: string): WorkspaceManifest | null {
  const file = manifestPath(workspacePath);
  if (!fs.existsSync(file)) return null;
  return parseManifest(fs.readFileSync(file, 'utf8'));
}
