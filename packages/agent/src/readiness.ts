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
    // Das Manifest ist optional: ohne es kennt DevDeck weder Toolchain noch .env-Projektion, das ist aber kein Fehler.
    checks.push({
      name: 'Manifest',
      status: 'OK',
      detail: 'optional – kein .devdeck/workspace.yaml (Toolchain-/Secret-Prüfung entfällt)',
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
  // Nur wenn das Manifest eine .env-Projektion verlangt, ist eine fehlende Datei ein Problem
  if (fs.existsSync(envPath)) {
    checks.push({ name: 'Secrets', status: 'OK' }, { name: 'Credentials', status: 'OK' });
  } else if (input.manifest?.environment) {
    checks.push(
      { name: 'Secrets', status: 'BLOCKED', detail: `${envTarget} fehlt – Sync/Provision projiziert sie aus dem Vault` },
      { name: 'Credentials', status: 'WARNING', detail: 'Noch keine projizierten Credentials' },
    );
  } else {
    checks.push(
      { name: 'Secrets', status: 'OK', detail: 'keine .env-Projektion konfiguriert' },
      { name: 'Credentials', status: 'OK', detail: 'keine .env-Projektion konfiguriert' },
    );
  }

  // Context-Dateien unter .devdeck/
  const contextPath = path.join(input.workspacePath, '.devdeck', 'CONTEXT.md');
  checks.push(
    fs.existsSync(contextPath)
      ? { name: 'Context', status: 'OK' }
      : { name: 'Context', status: 'WARNING', detail: 'context.refresh nicht ausgeführt' },
  );

  // Abgleich mit GitHub: unveröffentlichte Commits bzw. neuer Stand auf dem Remote
  if (input.gitState && input.isRepo) {
    const { ahead, behind } = input.gitState;
    if (ahead > 0) {
      checks.push({
        name: 'GitHub',
        status: 'WARNING',
        detail: `${ahead} lokale${ahead === 1 ? 'r Commit' : ' Commits'} nicht gepusht – ${behind > 0 ? `außerdem ${behind} neue auf dem Remote – ` : ''}bitte pushen`,
      });
    } else if (behind > 0) {
      checks.push({
        name: 'GitHub',
        status: 'WARNING',
        detail: `${behind} neue${behind === 1 ? 'r Commit' : ' Commits'} auf dem Remote – Sync ausführen`,
      });
    } else {
      checks.push({ name: 'GitHub', status: 'OK', detail: 'synchron mit dem Remote' });
    }
  }

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
