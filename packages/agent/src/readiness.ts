import fs from 'node:fs';
import path from 'node:path';
import type { GitState, ReadinessCheck, ReadinessReport } from '@devdeck/shared';
import type { WorkspaceManifest } from './manifest.js';
import { checkTool, requiredTools } from './tools.js';

export interface ReadinessInput {
  workspacePath: string;
  manifest: WorkspaceManifest | null;
  gitState: GitState | null;
  isRepo: boolean;
  gitAvailable: boolean;
}

function overallOf(checks: ReadinessCheck[]): ReadinessReport['overall'] {
  if (checks.some((c) => c.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((c) => c.status === 'WARNING')) return 'WARNING';
  return 'READY';
}

/**
 * Workspace Readiness (Spezifikation §17): Git, Repository, Runtime-Tools,
 * Dependencies, Secrets, Credentials, Context – plattformspezifisch möglich.
 */
export async function buildReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  checks.push(
    input.gitAvailable
      ? { name: 'Git', status: 'OK' }
      : { name: 'Git', status: 'BLOCKED', detail: 'git nicht im PATH' },
  );
  checks.push(
    input.isRepo
      ? { name: 'Repository', status: 'OK' }
      : { name: 'Repository', status: 'BLOCKED', detail: 'Kein Git-Repository' },
  );

  if (input.manifest) {
    checks.push({ name: 'Manifest', status: 'OK', detail: input.manifest.project.name });
  } else {
    checks.push({
      name: 'Manifest',
      status: 'WARNING',
      detail: '.devdeck/workspace.yaml fehlt',
    });
  }

  // Toolchain laut Manifest
  for (const tool of requiredTools(input.manifest)) {
    checks.push(await checkTool(tool.name, tool.level));
  }

  // Dependencies: package.json vorhanden → node_modules erwartet
  const pkgPath = path.join(input.workspacePath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const modules = path.join(input.workspacePath, 'node_modules');
    checks.push(
      fs.existsSync(modules)
        ? { name: 'Dependencies', status: 'OK' }
        : { name: 'Dependencies', status: 'BLOCKED', detail: 'node_modules fehlt (npm ci ausführen)' },
    );
  } else {
    checks.push({ name: 'Dependencies', status: 'OK', detail: 'kein package.json-Projekt' });
  }

  // Secrets/Credentials: Ziel-Env-Datei (nur Existenz prüfen, nie Werte lesen)
  const envTarget = input.manifest?.environment?.target ?? '.env';
  const envPath = path.join(input.workspacePath, envTarget);
  checks.push(
    fs.existsSync(envPath)
      ? { name: 'Secrets', status: 'OK' }
      : { name: 'Secrets', status: input.manifest?.environment ? 'BLOCKED' : 'WARNING', detail: `${envTarget} fehlt` },
  );
  checks.push(
    fs.existsSync(envPath)
      ? { name: 'Credentials', status: 'OK' }
      : { name: 'Credentials', status: 'WARNING', detail: 'Noch keine projizierten Credentials' },
  );

  // Context-Dateien unter .devdeck/
  const contextPath = path.join(input.workspacePath, '.devdeck', 'CONTEXT.md');
  checks.push(
    fs.existsSync(contextPath)
      ? { name: 'Context', status: 'OK' }
      : { name: 'Context', status: 'WARNING', detail: 'context.refresh nicht ausgeführt' },
  );

  // Git-Zustand als Hinweis (dirty blockiert nie die Readiness, aber der Sync stoppt)
  if (input.gitState?.dirty) {
    checks.push({
      name: 'Git-Änderungen',
      status: 'WARNING',
      detail: `${input.gitState.files.length} lokale Änderung(en) – Sync wird stoppen`,
    });
  }

  return { overall: overallOf(checks), checks };
}
