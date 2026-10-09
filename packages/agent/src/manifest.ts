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
