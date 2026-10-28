import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from './config.js';
import { ServerClient } from './client.js';
import { log } from './logger.js';

/**
 * Claude-Code-Sessions erfassen (CLI und Desktop schreiben beide nach `<claude-dir>/projects/<pfad>/<id>.jsonl`).
 * Übertragen werden AUSSCHLIESSLICH Metadaten: Titel, Zeiten, Branch, PR-Link, Nachrichtenanzahl.
 * Gesprächsinhalte, Prompts und Tool-Ausgaben verlassen den Rechner nie.
 */
export interface SessionSummary {
  external_id: string;
  title: string | null;
  started_at: string;
  last_activity_at: string;
  git_branch: string | null;
  pr_url: string | null;
  message_count: number;
  entrypoint: string | null;
  /** Arbeitsordner beim Start der Session */
  cwd: string;
  /** Arbeitsordner der letzten Nachricht */
  last_cwd: string;
  /** Alle verschiedenen Arbeitsordner der Session (begrenzt) – eine Session kann nach einem Umzug des Projekts den Ordner wechseln */
  cwds: string[];
}

export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/** Claude kodiert den Projektpfad als Ordnernamen: alles außer [A-Za-z0-9] wird zu `-`. */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Git-Bash/MSYS-Pfade (`/d/Projekt`) unter Windows in die übliche Form (`D:\Projekt`) bringen. */
export function normalizeCwd(p: string, platform: NodeJS.Platform = process.platform): string {
  const m = platform === 'win32' ? /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p) : null;
  return m ? `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : p;
}

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

function insideWorkspace(cwd: string, workspace: string): boolean {
  const c = norm(path.resolve(cwd));
  const w = norm(path.resolve(workspace));
  return c === w || c.startsWith(w + path.sep);
}

/** Eine Transcript-Datei zusammenfassen; null, wenn leer oder nicht lesbar. */
export function summarizeTranscript(file: string): SessionSummary | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let title: string | null = null;
  let branch: string | null = null;
  let pr: string | null = null;
  let entrypoint: string | null = null;
  let cwd: string | null = null;
  let lastCwd: string | null = null;
  const cwds = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // unvollständige letzte Zeile während die Session schreibt
    }
    if (o.isSidechain) continue;
    if (typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp))) {
      first ??= o.timestamp;
      last = o.timestamp;
    }
    if (typeof o.cwd === 'string' && o.cwd) {
      const c = normalizeCwd(o.cwd);
      cwd ??= c;
      lastCwd = c;
      if (cwds.size < 200) cwds.add(c);
    }
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') branch = o.gitBranch;
    if (typeof o.entrypoint === 'string' && o.entrypoint) entrypoint ??= o.entrypoint;
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) title = o.aiTitle.trim();
    if (o.type === 'pr-link' && typeof o.prUrl === 'string') pr = o.prUrl;
    if (o.type === 'user' || o.type === 'assistant') count++;
  }
  if (!first || !last || !cwd || !lastCwd || count === 0) return null;
  return {
    external_id: path.basename(file, '.jsonl'),
    title,
    started_at: new Date(first).toISOString(),
    last_activity_at: new Date(last).toISOString(),
    git_branch: branch,
    pr_url: pr,
    message_count: count,
    entrypoint,
    cwd,
    last_cwd: lastCwd,
    cwds: [...cwds],
  };
}

/** Alle Sessions finden, deren Arbeitsordner innerhalb des Workspaces liegt. */
export function scanWorkspace(
  workspacePath: string,
  dir: string,
  seen?: Map<string, string>,
  /** Signaturen der gefundenen Dateien – erst nach erfolgreicher Meldung in `seen` übernehmen. */
  pending?: Map<string, string>,
): SessionSummary[] {
  const projects = path.join(dir, 'projects');
  const enc = encodeProjectPath(path.resolve(workspacePath));
  let folders: string[];
  try {
    folders = fs.readdirSync(projects).filter((n) => n === enc || n.startsWith(`${enc}-`));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const folder of folders) {
    const full = path.join(projects, folder);
    let files: string[];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const sig = `${stat.mtimeMs}:${stat.size}`;
      if (seen?.get(file) === sig) continue; // unverändert seit dem letzten Scan
      const summary = summarizeTranscript(file);
      // Liegt die Datei genau im Ordner dieses Workspaces, genügt ein Arbeitsordner darin: Wurde das Projekt verschoben, steht am Anfang
      // der Session noch der alte Pfad (Sessions werden unter dem neuen Ordner fortgesetzt). In Unterordner-Ordnern gilt Start oder letzter Ordner.
      const belongs = summary !== null && (folder === enc
        ? summary.cwds.some((c) => insideWorkspace(c, workspacePath))
        : insideWorkspace(summary.cwd, workspacePath) || insideWorkspace(summary.last_cwd, workspacePath));
      if (summary && belongs) {
        out.push(summary);
        pending?.set(file, sig);
      } else {
        seen?.set(file, sig); // nicht relevant – nicht erneut lesen
      }
    }
  }
  return out;
}

export interface ScanResult {
  workspaces: number;
  sent: number;
}

/** Einmal scannen und an den Server melden. */
export async function scanAndReport(
  client: ServerClient,
  dir: string,
  seen: Map<string, string>,
): Promise<ScanResult> {
  const ws = await client.request<Array<{ id: string; local_path: string }>>('GET', '/api/agent/workspaces', {
    timeoutMs: 10_000,
  });
  if (ws.status !== 200 || !ws.data) return { workspaces: 0, sent: 0 };
  let sent = 0;
  for (const w of ws.data) {
    const pending = new Map<string, string>();
    const sessions = scanWorkspace(w.local_path, dir, seen, pending);
    let ok = true;
    for (let i = 0; i < sessions.length; i += 100) {
      const chunk = sessions.slice(i, i + 100).map((s) => ({
        workspace_id: w.id,
        external_id: s.external_id,
        title: s.title,
        started_at: s.started_at,
        last_activity_at: s.last_activity_at,
        git_branch: s.git_branch,
        pr_url: s.pr_url,
        message_count: s.message_count,
        entrypoint: s.entrypoint,
      }));
      const res = await client.request('POST', '/api/agent/sessions/import', {
        body: { sessions: chunk },
        timeoutMs: 20_000,
      });
      if (res.status === 200) sent += chunk.length;
      else {
        ok = false;
        log.error(`Session-Import fehlgeschlagen: HTTP ${res.status}`);
      }
    }
    if (ok) for (const [file, sig] of pending) seen.set(file, sig);
  }
  return { workspaces: ws.data.length, sent };
}

/** Hintergrund-Scanner (Default alle 5 Minuten; DEVDECK_SCAN_SESSIONS=0 schaltet ihn ab). */
export function startSessionScanner(
  config: AgentConfig,
  options: { intervalMs?: number; claudeConfigDir?: string } = {},
): { stop(): void } {
  if (process.env.DEVDECK_SCAN_SESSIONS === '0') return { stop() {} };
  const client = new ServerClient(config);
  const dir = options.claudeConfigDir ?? claudeDir();
  const seen = new Map<string, string>();
  let stopped = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await scanAndReport(client, dir, seen);
      if (r.sent > 0) log.info(`Claude-Code-Sessions gemeldet: ${r.sent} (Workspaces: ${r.workspaces})`);
    } catch (err) {
      log.error(`Session-Scan fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(() => void run(), 5_000).unref?.();
  const timer = setInterval(() => void run(), options.intervalMs ?? 300_000);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
