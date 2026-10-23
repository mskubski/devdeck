import fs from 'node:fs';
import path from 'node:path';
import { defaultConfigPath } from './config.js';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Pfad der Agent-Logdatei (neben der Agent-Konfiguration, überschreibbar per DEVDECK_AGENT_LOG). */
export function logFilePath(): string {
  return process.env.DEVDECK_AGENT_LOG ?? path.join(path.dirname(defaultConfigPath()), 'agent.log');
}

function append(line: string): void {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* Datei existiert noch nicht */
    }
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* Logging darf den Agenten nie stoppen */
  }
}

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  (level === 'INFO' ? console.log : console.error)(`[DevDeck Agent] ${message}`);
  append(line);
}

export const log = {
  info: (message: string): void => write('INFO', message),
  warn: (message: string): void => write('WARN', message),
  error: (message: string): void => write('ERROR', message),
};
