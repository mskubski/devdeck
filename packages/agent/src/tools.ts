import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ReadinessCheck } from '@devdeck/shared';
import type { WorkspaceManifest } from './manifest.js';

const exec = promisify(execFile);

async function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: timeoutMs, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

function which(bin: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, `${bin}${ext}`))) return true;
      } catch {
        /* ungültiger PATH-Eintrag ignorieren */
      }
    }
  }
  return false;
}

/**
 * Tool-Erkennung – registry-basiert, damit zusätzliche Runtime-Typen später
 * ohne Strukturbruch ergänzt werden können (PLAN §12).
 */
type ToolProbe = () => Promise<{ found: boolean; version?: string; detail?: string }>;

const PROBES: Record<string, ToolProbe> = {
  git: async () => {
    const v = await run('git', ['--version']);
    return { found: v !== null, ...(v ? { version: v } : {}) };
  },
  node: async () => {
    const v = await run('node', ['--version']);
    return { found: v !== null, ...(v ? { version: v } : {}) };
  },
  npm: async () => {
    const v = await run('npm', ['--version']);
    return { found: v !== null, ...(v ? { version: v } : {}) };
  },
  pnpm: async () => ({ found: which('pnpm') }),
  yarn: async () => ({ found: which('yarn') }),
  bun: async () => ({ found: which('bun') }),
  supabase: async () => {
    const v = await run('supabase', ['--version']);
    return { found: v !== null, ...(v ? { version: v } : {}) };
  },
  docker: async () => ({ found: which('docker') }),
  python: async () => {
    const v = await run('python3', ['--version']);
    return { found: v !== null, ...(v ? { version: v } : {}) };
  },
  // Plattformspezifisch: Xcode nur auf macOS relevant (Spezifikation §17)
  xcode: async () => {
    if (process.platform !== 'darwin') {
      return { found: true, detail: 'nicht auf dieser Plattform relevant' };
    }
    const v = await run('xcodebuild', ['-version']);
    return { found: v !== null, ...(v ? { version: v.split('\n')[0] ?? v } : {}) };
  },
  'android-sdk': async () => {
    const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (home && fs.existsSync(home)) return { found: true, detail: home };
    const fallback = path.join(os.homedir(), 'Android', 'Sdk');
    if (fs.existsSync(fallback)) return { found: true, detail: fallback };
    return { found: false, detail: 'ANDROID_HOME nicht gesetzt' };
  },
  java: async () => {
    const v = await run('java', ['-version']);
    return { found: v !== null };
  },
};

export type ToolLevel = 'required' | 'optional';

/** Aus dem Manifest ableiten, welche Tools geprüft werden müssen. */
export function requiredTools(manifest: WorkspaceManifest | null): Array<{ name: string; level: ToolLevel }> {
  const out = new Map<string, ToolLevel>();
  const add = (name: string, level: ToolLevel): void => {
    const existing = out.get(name);
    if (existing === 'required' || level === 'required') out.set(name, 'required');
    else out.set(name, 'optional');
  };

  add('git', 'required');
  if (manifest) {
    for (const tool of manifest.tools ?? []) add(tool, 'required');
    if (manifest.runtime?.node) add('node', 'required');
    if (manifest.runtime?.npm) add('npm', 'required');
    if (manifest.package_manager?.type) add(manifest.package_manager.type, 'required');
    if (manifest.services?.supabase) add('supabase', 'optional');
    if (manifest.mobile?.android) add('android-sdk', 'optional');
    if (manifest.mobile?.android) add('java', 'optional');
    if (manifest.mobile?.ios) add('xcode', 'optional');
  } else {
    add('node', 'optional');
    add('npm', 'optional');
  }
  return [...out.entries()].map(([name, level]) => ({ name, level }));
}

/** Einzelnes Tool prüfen → Readiness-Check. */
export async function checkTool(name: string, level: ToolLevel): Promise<ReadinessCheck> {
  const probe = PROBES[name];
  if (!probe) {
    return {
      name,
      status: level === 'required' ? 'BLOCKED' : 'WARNING',
      detail: 'Unbekanntes Tool – manuell prüfen',
    };
  }
  const result = await probe();
  const status = result.found ? 'OK' : level === 'required' ? 'BLOCKED' : 'WARNING';
  return {
    name,
    status,
    ...(result.version ? { detail: result.version } : result.detail ? { detail: result.detail } : {}),
  };
}
