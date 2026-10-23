import type { ArchComponent, ArchLink, ArchDetail, GitState, WorkspaceFacts } from '@devdeck/shared';
import { SERVICE_RULES, formatBytes, providerForHost, supabaseRef, supabaseRegion } from './catalog.js';

export interface DeriveInput {
  project: { name: string; repo_remote: string | null; default_branch: string | null };
  workspaces: Array<{
    machine_name: string;
    machine_online: boolean;
    local_path: string;
    branch: string | null;
    status: string;
    git: GitState | null;
    checked_at: string | null;
    claude_sessions_30d: number;
  }>;
  secretNames: string[];
  /** Fakten aller Workspaces des Projekts (bereits zusammengeführt) */
  facts: Pick<WorkspaceFacts, 'env' | 'markers' | 'packages' | 'databases'>;
  connectors: Array<{ type: string; name: string; last_check_ok: boolean | null; last_check_message: string | null }>;
}

export interface Derived {
  components: ArchComponent[];
  links: ArchLink[];
}

const linkId = (from: string, to: string, label: string): string => `${from}>${to}|${label}`;

function statusOf(s: string): ArchComponent['status'] {
  return s === 'ready' ? 'ok' : s === 'warning' ? 'warn' : s === 'blocked' ? 'bad' : 'unknown';
}

/** Rein funktionale Ableitung der Architektur aus Projektdaten und Agent-Fakten (keine KI, keine Netzwerkzugriffe). */
export function deriveArchitecture(input: DeriveInput): Derived {
  const components: ArchComponent[] = [];
  const links: ArchLink[] = [];
  const add = (c: Omit<ArchComponent, 'source' | 'details'> & { details?: ArchDetail[] }): ArchComponent => {
    const full: ArchComponent = { source: 'auto', details: [], ...c };
    components.push(full);
    return full;
  };
  const link = (from: string, to: string, label: string, description: string | null = null, dashed = false): void => {
    links.push({ id: linkId(from, to, label), from, to, label, description, source: 'auto', ...(dashed ? { dashed } : {}) });
  };

  const envNames = new Set<string>([...input.facts.env.map((e) => e.name), ...input.secretNames]);
  const hostOf = (re: RegExp): string | undefined => input.facts.env.find((e) => re.test(e.name) && e.host)?.host;
  const pkgs = input.facts.packages;
  const markers = new Set(input.facts.markers);
  const claimed = new Set<string>();

  // --- Entwicklung: eine Komponente je Maschine mit Workspace ---
  const devKeys: string[] = [];
  const byMachine = new Map<string, DeriveInput['workspaces']>();
  for (const w of input.workspaces) byMachine.set(w.machine_name, [...(byMachine.get(w.machine_name) ?? []), w]);
  for (const [machine, list] of byMachine) {
    const key = `dev:${machine}`;
    devKeys.push(key);
    const worst = list.map((w) => statusOf(w.status)).sort((a, b) => ['bad', 'warn', 'unknown', 'ok'].indexOf(a!) - ['bad', 'warn', 'unknown', 'ok'].indexOf(b!))[0];
    const details: ArchDetail[] = list.map((w) => ({ label: 'Ordner', value: w.local_path }));
    const g = list[0]!.git;
    if (list[0]!.branch) details.push({ label: 'Branch', value: list[0]!.branch! });
    if (g) details.push({ label: 'Git', value: `${g.dirty ? `${g.files.length} lokale Änderung(en)` : 'sauber'}, ${g.ahead} zu pushen, ${g.behind} neu auf dem Remote` });
    const sessions = list.reduce((n, w) => n + w.claude_sessions_30d, 0);
    if (sessions > 0) details.push({ label: 'Claude-Code-Sessions (30 Tage)', value: String(sessions) });
    details.push({ label: 'Agent', value: list[0]!.machine_online ? 'online' : 'offline' });
    add({
      key, kind: 'dev', name: machine, provider: 'Entwicklung', status: list[0]!.machine_online ? worst : 'unknown',
      description: 'Entwicklungsrechner mit DevDeck-Agent: hier wird am Code gearbeitet (z. B. mit Claude Code).',
      details,
    });
  }

  // --- Repository ---
  let repoKey: string | null = null;
  if (input.project.repo_remote) {
    const url = input.project.repo_remote;
    const m = /^(?:https?:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(url);
    const host = m?.[1] ?? '';
    const provider = /github\.com/.test(host) ? 'GitHub' : /gitlab/.test(host) ? 'GitLab' : /bitbucket/.test(host) ? 'Bitbucket' : 'Git';
    const git = input.workspaces.find((w) => w.git)?.git;
    const pending = input.workspaces.some((w) => (w.git?.ahead ?? 0) > 0 || (w.git?.behind ?? 0) > 0);
    const details: ArchDetail[] = [{ label: 'URL', value: url }];
    if (input.project.default_branch) details.push({ label: 'Standard-Branch', value: input.project.default_branch });
    const conn = input.connectors.find((c) => c.type === 'github');
    if (conn?.last_check_message) details.push({ label: 'GitHub-Konnektor', value: conn.last_check_message });
    if (git) details.push({ label: 'Abgleich', value: `${git.ahead} lokale Commits nicht gepusht, ${git.behind} neu auf dem Remote` });
    repoKey = 'repo';
    add({
      key: repoKey, kind: 'repo', name: m?.[2] ? `${provider}: ${m[2]}` : provider, provider,
      status: pending ? 'warn' : input.workspaces.length ? 'ok' : 'unknown',
      description: 'Quelle der Wahrheit für den Quellcode; von hier holen Entwicklungsrechner und Server den aktuellen Stand.',
      details,
    });
    for (const d of devKeys) link(d, repoKey, 'push / pull', 'Code wird per Git mit dem Repository synchronisiert.');
  }

  // --- Hosting ---
  const hostings: string[] = [];
  const addHosting = (id: string, name: string, provider: string | null, description: string, details: ArchDetail[] = []): void => {
    add({ key: `hosting:${id}`, kind: 'hosting', name, provider, description, details });
    hostings.push(`hosting:${id}`);
  };
  if (markers.has('vercel.json') || markers.has('.vercel/project.json') || [...envNames].some((n) => /^VERCEL_/.test(n))) {
    addHosting('vercel', 'Vercel', 'Vercel', 'Gehostete Web-Anwendung (Serverless), Deployments bei jedem Push.');
  }
  if (markers.has('netlify.toml')) addHosting('netlify', 'Netlify', 'Netlify', 'Gehostete Web-Anwendung.');
  if (markers.has('fly.toml')) addHosting('fly', 'Fly.io', 'Fly.io', 'Container-Hosting.');
  if (markers.has('render.yaml')) addHosting('render', 'Render', 'Render', 'Gehostete Anwendung.');
  if (markers.has('wrangler.toml')) addHosting('cloudflare', 'Cloudflare Workers', 'Cloudflare', 'Edge-Hosting.');
  const dockerFiles = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'].filter((f) => markers.has(f));
  if (dockerFiles.length) addHosting('docker', 'Docker (Container)', 'Docker', 'Die Anwendung läuft als Container.', [{ label: 'Dateien', value: dockerFiles.join(', ') }]);
  if (markers.has('systemd')) addHosting('systemd', 'systemd-Dienst', 'Linux-Server', 'Die Anwendung läuft als Hintergrunddienst und startet automatisch neu.');
  const primary: string = hostings[0] ?? 'hosting:unknown';
  if (hostings.length === 0) {
    add({
      key: primary, kind: 'hosting', name: 'Betrieb: noch nicht festgelegt', provider: null, placeholder: true,
      description: 'Wo läuft die Anwendung (Server, Vercel, Webspace …)? Im Manifest .devdeck/architecture.yaml festhalten oder hier über „Bearbeiten“ eintragen.',
    });
  }
  if (repoKey) link(repoKey, primary, 'Deployment', 'Neuer Stand wird aus dem Repository geholt bzw. ausgerollt.', hostings.length === 0);

  // Webspace (z. B. IONOS) für Website-Veröffentlichung
  const webHost = hostOf(/^(WEBSERVER|FTP|SFTP|SSH|DEPLOY)_(HOST|SERVER)$/) ?? hostOf(/^(WEBSERVER|FTP|SFTP)_.*HOST/);
  if (webHost || [...envNames].some((n) => /^WEBSERVER_/.test(n))) {
    const provider = providerForHost(webHost);
    for (const n of envNames) if (/^(WEBSERVER|FTP|SFTP)_/.test(n)) claimed.add(n);
    add({
      key: 'hosting:webspace', kind: 'hosting', name: provider ? `Webspace (${provider})` : 'Webserver / Webspace', provider,
      description: 'Hier wird die Website veröffentlicht (Upload per FTP/SFTP/SSH).',
      details: webHost ? [{ label: 'Host', value: webHost }] : [],
    });
    link(primary, 'hosting:webspace', 'veröffentlicht', 'Die Anwendung lädt Website-Inhalte auf den Webspace hoch.');
  }

  // --- Datenbanken ---
  const dbKeys: string[] = [];
  const addDb = (id: string, name: string, provider: string | null, description: string, details: ArchDetail[] = []): void => {
    add({ key: `db:${id}`, kind: 'database', name, provider, description, details });
    dbKeys.push(`db:${id}`);
  };
  const supabaseHosts = input.facts.env.map((e) => e.host).filter((h): h is string => !!h && /supabase\.(co|com)$/.test(h));
  if (supabaseHosts.length || [...envNames].some((n) => /SUPABASE/i.test(n)) || pkgs.some((p) => /supabase/.test(p))) {
    for (const n of envNames) if (/SUPABASE/i.test(n)) claimed.add(n);
    const details: ArchDetail[] = [];
    const ref = supabaseHosts.map(supabaseRef).find(Boolean);
    const region = supabaseHosts.map(supabaseRegion).find(Boolean);
    if (ref) details.push({ label: 'Projekt', value: ref });
    details.push({ label: 'Region', value: region ?? 'unbekannt (Pooler-URL oder Supabase-Token nötig)' });
    details.push({ label: 'Größe', value: 'Live-Wert folgt mit dem Supabase-Konnektor (Token)' });
    addDb('supabase', 'Supabase (PostgreSQL + Storage)', 'Supabase', 'Gehostete Datenbank mit Dateispeicher und Auth.', details);
  }
  const dbUrlHost = hostOf(/^(DATABASE|DB|POSTGRES|PG|MYSQL)(_.*)?_(URL|HOST)$/);
  const isPg = pkgs.some((p) => /^(psycopg2(-binary)?|psycopg|asyncpg|pg|postgres)$/.test(p)) || [...envNames].some((n) => /^(POSTGRES|PG)/.test(n));
  if (isPg && !dbKeys.includes('db:supabase')) {
    const local = !dbUrlHost || /^(localhost|127\.0\.0\.1|db|postgres)$/.test(dbUrlHost);
    addDb('postgres', local ? 'PostgreSQL (lokal)' : `PostgreSQL (${dbUrlHost})`, providerForHost(dbUrlHost), 'Relationale Datenbank für die Anwendungsdaten.', dbUrlHost ? [{ label: 'Host', value: dbUrlHost }] : []);
  }
  if (pkgs.some((p) => /^(mysql2?|pymysql|mysqlclient|mariadb)$/.test(p)) || [...envNames].some((n) => /^MYSQL_/.test(n))) {
    addDb('mysql', 'MySQL / MariaDB', providerForHost(dbUrlHost), 'Relationale Datenbank für die Anwendungsdaten.', dbUrlHost ? [{ label: 'Host', value: dbUrlHost }] : []);
  }
  if (pkgs.some((p) => /^(pymongo|mongoose|mongodb|motor)$/.test(p)) || [...envNames].some((n) => /^MONGO/.test(n))) {
    addDb('mongodb', 'MongoDB', null, 'Dokumentendatenbank.');
  }
  if (input.facts.databases.length) {
    const total = input.facts.databases.reduce((n, d) => n + d.bytes, 0);
    addDb('sqlite', `SQLite (lokal) · ${formatBytes(total)}`, 'SQLite', 'Eingebettete Datei-Datenbank auf dem Server.',
      input.facts.databases.slice(0, 6).map((d) => ({ label: d.path, value: formatBytes(d.bytes) })));
  }
  for (const d of dbKeys) link(primary, d, 'liest / schreibt', 'Speichert und liest die Anwendungsdaten.', hostings.length === 0);

  // --- Externe Dienste aus Variablen-Namen / Paketen ---
  const hostDetail = (label: string, re: RegExp): ArchDetail | null => {
    const h = hostOf(re);
    return h ? { label, value: h } : null;
  };
  for (const rule of SERVICE_RULES) {
    const matchedEnv = [...envNames].filter((n) => rule.env?.test(n));
    const matchedPkg = pkgs.filter((p) => rule.pkg?.test(p));
    if (matchedEnv.length === 0 && matchedPkg.length === 0) continue;
    matchedEnv.forEach((n) => claimed.add(n));
    const details: ArchDetail[] = [];
    let provider: string | null = null;
    if (rule.id === 'mail') {
      const imap = hostDetail('IMAP-Server', /^IMAP_.*HOST|^IMAP_SERVER/);
      const smtp = hostDetail('SMTP-Server', /^SMTP_.*HOST|^SMTP_SERVER/);
      if (imap) details.push(imap);
      if (smtp) details.push(smtp);
      provider = providerForHost(imap?.value ?? smtp?.value);
    }
    if (rule.id === 'ollama') {
      const h = hostDetail('Host', /^OLLAMA_/);
      if (h) details.push(h);
    }
    if (matchedEnv.length) details.push({ label: 'Konfiguration', value: `${matchedEnv.length} Variable${matchedEnv.length === 1 ? '' : 'n'} (${matchedEnv.slice(0, 3).join(', ')}${matchedEnv.length > 3 ? ', …' : ''})` });
    if (matchedPkg.length) details.push({ label: 'Bibliothek', value: matchedPkg.slice(0, 3).join(', ') });
    const key = `svc:${rule.id}`;
    add({ key, kind: rule.kind, name: rule.name, provider, description: rule.description, details });
    link(primary, key, rule.link, null, hostings.length === 0);
  }

  // --- Nicht zugeordnete Zugangsdaten als Hinweis ---
  const unclaimed = [...envNames].filter((n) =>
    /(API_?KEY|TOKEN|SECRET)$/i.test(n) && !claimed.has(n) && !/^(SECRET_KEY|GUI_.*)$/.test(n) &&
    !SERVICE_RULES.some((r) => r.env?.test(n)));
  if (unclaimed.length) {
    add({
      key: 'svc:unclaimed', kind: 'other', name: 'Weitere Zugangsdaten', provider: null, placeholder: true,
      description: 'Diese Variablen gehören vermutlich zu weiteren externen Diensten, die noch nicht erkannt sind. Bitte im Manifest beschreiben.',
      details: [{ label: 'Variablen', value: unclaimed.slice(0, 6).join(', ') + (unclaimed.length > 6 ? ', …' : '') }],
    });
    link(primary, 'svc:unclaimed', 'nutzt', null, true);
  }

  return { components, links };
}
