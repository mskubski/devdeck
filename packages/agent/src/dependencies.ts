import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@devdeck/shared';
import type { WorkspaceManifest } from './manifest.js';

const exec = promisify(execFile);

/** Hash des relevanten Lockfiles (oder beider) für die Dependency-Erkennung. */
export async function lockfileHash(workspacePath: string): Promise<string | null> {
  const hash = createHash('sha256');
  let touched = false;
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    const full = path.join(workspacePath, file);
    if (fs.existsSync(full)) {
      hash.update(file);
      hash.update(fs.readFileSync(full));
      touched = true;
    }
  }
  return touched ? hash.digest('hex') : null;
}

function shellMeta(value: string): boolean {
  return /[;&|`$><]/.test(value);
}

/**
 * Dependencies lokal reproduzieren (Spezifikation §9) – nie zwischen Rechnern
 * kopiert. Installationsbefehl kommt ausschließlich aus dem Manifest und wird
 * ohne Shell als Argumentliste ausgeführt.
 */
export async function installDependencies(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<{ command: string; output_tail: string }> {
  const install = manifest.package_manager?.install ?? 'npm ci';
  if (shellMeta(install)) {
    throw new AppError('MANIFEST_INVALID', 'package_manager.install enthält unzulässige Zeichen');
  }
  const [cmd, ...args] = install.split(/\s+/);
  if (!cmd) throw new AppError('MANIFEST_INVALID', 'package_manager.install ist leer');

  const hasLock =
    fs.existsSync(path.join(workspacePath, 'package-lock.json')) ||
    fs.existsSync(path.join(workspacePath, 'yarn.lock')) ||
    fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml'));
  const effectiveCmd = cmd === 'npm' && !hasLock && args[0] === 'ci' ? 'npm' : cmd;
  const effectiveArgs = effectiveCmd === 'npm' && !hasLock && args[0] === 'ci' ? ['install'] : args;

  try {
    const { stdout, stderr } = await exec(effectiveCmd, effectiveArgs, {
      cwd: workspacePath,
      timeout: 15 * 60_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const tail = `${stdout}\n${stderr}`.slice(-2000);
    return { command: [effectiveCmd, ...effectiveArgs].join(' '), output_tail: tail };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(-2000);
    throw new AppError(
      'DEP_FAILED',
      `Dependency-Installation schlug fehl (${[effectiveCmd, ...effectiveArgs].join(' ')})`,
      { output_tail: tail },
    );
  }
}
