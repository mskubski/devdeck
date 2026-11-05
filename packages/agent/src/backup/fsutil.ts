import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';

/** Verbindet `rel` mit `base` und stellt sicher, dass das Ergebnis innerhalb von `base` liegt (z. B. Objektnamen aus Storage). */
export function safeJoin(base: string, rel: string): string {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new AppError('FORBIDDEN', `Pfad außerhalb des Zielordners: ${rel}`);
  }
  return full;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Alle Dateien unterhalb von `dir` (relative Pfade mit `/`), ohne Symlinks zu folgen. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(current, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

export function dirBytes(dir: string): number {
  let total = 0;
  for (const rel of listFiles(dir)) {
    try {
      total += fs.statSync(path.join(dir, rel)).size;
    } catch {
      /* Datei verschwunden */
    }
  }
  return total;
}

/** Externes Programm ohne Shell starten; Zugangsdaten nur über `env`, nie über Argumente. */
export function run(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: { ...process.env, ...(options.env ?? {}) },
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 6 * 3_600_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          reject(new AppError('TOOL_MISSING', `Programm „${command}“ ist auf dieser Maschine nicht installiert`));
          return;
        }
        reject(new AppError('INTERNAL', `${command} fehlgeschlagen: ${(stderr || e.message).toString().trim().slice(0, 400)}`));
      },
    );
  });
}

/** Ordnernamen, die nie gesichert werden (Abhängigkeiten, Repository, Zugangsdaten). */
export const ALWAYS_EXCLUDED = ['node_modules', '.git', '.env', '.env.*', '*.key', 'agent.json'];
