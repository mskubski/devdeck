import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHostyName, sanitizeHost, validateArchManifest } from '@devdeck/shared';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';
import { deriveArchitecture } from '../src/services/architecture/derive.js';
import { supabaseRegion } from '../src/services/architecture/catalog.js';

describe('Architektur: Hilfsfunktionen', () => {
  it('sanitizeHost entfernt Zugangsdaten, Port, Pfad; verwirft Nicht-Hosts', () => {
    expect(sanitizeHost('postgresql://user:geheim@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')).toBe('aws-0-eu-central-1.pooler.supabase.com');
    expect(sanitizeHost('imap.ionos.de')).toBe('imap.ionos.de');
    expect(sanitizeHost('https://Example.COM/pfad?token=abc')).toBe('example.com');
    expect(sanitizeHost('sk-ant-api03-abcdef')).toBeNull();
    expect(sanitizeHost('claude-sonnet')).toBeNull();
    expect(sanitizeHost('localhost:5432')).toBe('localhost');
    expect(sanitizeHost('')).toBeNull();
  });

  it('isHostyName: Hosts ja, Geheimnisse nein', () => {
    for (const n of ['IMAP_HOST', 'SMTP_HOST', 'DATABASE_URL', 'SUPABASE_URL', 'WEBSERVER_HOST']) expect(isHostyName(n)).toBe(true);
    for (const n of ['EMAIL_PASS', 'API_KEY', 'TELEGRAM_BOT_TOKEN', 'SECRET_KEY', 'AUTH_URL', 'WEBSERVER_USER']) expect(isHostyName(n)).toBe(false);
  });

  it('supabaseRegion erkennt Pooler-Hostnamen', () => {
    expect(supabaseRegion('aws-0-eu-central-1.pooler.supabase.com')).toBe('eu-central-1 (Frankfurt)');
    expect(supabaseRegion('db.abc.supabase.co')).toBeNull();
  });

  it('validateArchManifest: gültig, ungültige Typen, doppelte IDs', () => {
    const ok = validateArchManifest({ version: 1, components: [{ id: 'telegram', kind: 'messaging', name: 'Telegram', description: 'x', details: { Bot: '@x' } }], links: [{ from: 'app', to: 'telegram', label: 'Nachrichten' }] });
    expect(ok.error).toBeNull();
    expect(ok.manifest?.components[0]?.details).toEqual({ Bot: '@x' });
    expect(validateArchManifest({ version: 2 }).error).toContain('version');
    expect(validateArchManifest({ version: 1, components: [{ id: 'a', kind: 'bogus', name: 'A' }] }).error).toContain('kind');
    expect(validateArchManifest({ version: 1, components: [{ id: 'a', kind: 'other', name: 'A' }, { id: 'a', kind: 'other', name: 'B' }] }).error).toContain('doppelt');
  });
});

describe('Architektur: automatische Ableitung', () => {
  const base = {
    project: { name: 'helferle', repo_remote: 'https://github.com/mskubski/helferle', default_branch: 'main' },
    workspaces: [{ machine_name: 'helferle', machine_online: true, local_path: '/home/k/helferle', branch: 'main', status: 'warning',
      git: { branch: 'main', commit: 'a', dirty: false, ahead: 7, behind: 0, files: [] }, checked_at: null, claude_sessions_30d: 5 }],
    connectors: [],
  };

  it('erkennt Entwicklung, Repo, Dienste, DB und zeigt fehlendes Hosting als Platzhalter', () => {
    const d = deriveArchitecture({
      ...base,
      secretNames: ['TELEGRAM_BOT_TOKEN', 'EMAIL_PASS', 'ANTHROPIC_FAILBACK_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'BREVO_API_KEY', 'SECRET_KEY', 'GUI_PASS', 'FOO_API_KEY'],
      facts: {
        env: [{ name: 'IMAP_HOST', host: 'imap.ionos.de' }, { name: 'SMTP_HOST', host: 'smtp.ionos.de' }, { name: 'WEBSERVER_HOST', host: 'home123.1and1-data.host' }, { name: 'WEBSERVER_USER' }],
        markers: [], packages: ['python-telegram-bot', 'anthropic', 'flask'],
        databases: [{ kind: 'sqlite', path: 'data/app.db', bytes: 5 * 1024 * 1024 }],
      },
    });
    const keys = d.components.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['dev:helferle', 'repo', 'hosting:unknown', 'db:sqlite', 'svc:telegram', 'svc:mail', 'svc:anthropic', 'svc:mistral', 'svc:openrouter', 'svc:brevo', 'hosting:webspace', 'svc:unclaimed']));
    const mail = d.components.find((c) => c.key === 'svc:mail')!;
    expect(mail.provider).toBe('IONOS');
    expect(mail.details.map((x) => x.value)).toEqual(expect.arrayContaining(['imap.ionos.de', 'smtp.ionos.de']));
    expect(d.components.find((c) => c.key === 'hosting:unknown')?.placeholder).toBe(true);
    expect(d.components.find((c) => c.key === 'db:sqlite')?.name).toContain('5.0 MB');
    expect(d.components.find((c) => c.key === 'repo')?.status).toBe('warn'); // 7 ungepushte Commits
    expect(d.components.find((c) => c.key === 'svc:unclaimed')?.details[0]?.value).toContain('FOO_API_KEY');
    expect(d.components.find((c) => c.key === 'svc:unclaimed')?.details[0]?.value).not.toContain('SECRET_KEY');
    const linkSet = d.links.map((l) => `${l.from}>${l.to}`);
    expect(linkSet).toEqual(expect.arrayContaining(['dev:helferle>repo', 'repo>hosting:unknown', 'hosting:unknown>svc:telegram', 'hosting:unknown>db:sqlite', 'hosting:unknown>hosting:webspace']));
  });

  it('Supabase mit Pooler-Host: Region und Projekt; Vercel aus vercel.json', () => {
    const d = deriveArchitecture({
      ...base, secretNames: ['SUPABASE_SERVICE_ROLE_KEY'],
      facts: { env: [{ name: 'DATABASE_URL', host: 'aws-0-eu-central-1.pooler.supabase.com' }, { name: 'SUPABASE_URL', host: 'abcdefghijklmnopqrst.supabase.co' }], markers: ['vercel.json'], packages: ['@supabase/supabase-js'], databases: [] },
    });
    const db = d.components.find((c) => c.key === 'db:supabase')!;
    expect(db.details.find((x) => x.label === 'Region')?.value).toBe('eu-central-1 (Frankfurt)');
    expect(db.details.find((x) => x.label === 'Projekt')?.value).toBe('abcdefghijklmnopqrst');
    expect(d.components.some((c) => c.key === 'hosting:vercel')).toBe(true);
    expect(d.components.some((c) => c.key === 'hosting:unknown')).toBe(false);
    expect(d.links.some((l) => l.from === 'hosting:vercel' && l.to === 'db:supabase')).toBe(true);
  });
});

describe('Architektur: API (Fakten, Manifest, manuelle Anpassungen)', () => {
  let srv: TestServer;
  let cookie: string;
  let projectId: string;
  let machineId: string;
  let machineToken: string;
  let wsId: string;
  const base = () => `/api/projects/${projectId}/architecture`;
  const model = async () => (await srv.request('GET', base(), { cookie })).body.data;
  const find = (m: any, key: string) => m.components.find((c: any) => c.key === key);

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'App' } })).body.data.id;
    srv.ctx.db.run('UPDATE projects SET repo_remote = ? WHERE id = ?', 'https://github.com/x/app', projectId);
    const m = await srv.enroll(cookie, 'pc');
    machineId = m.machineId;
    machineToken = m.token;
    srv.ctx.db.run(`UPDATE machines SET agent_status='online', platform='linux', workspace_root='/data' WHERE id=?`, machineId);
    wsId = (await srv.request('POST', `/api/projects/${projectId}/workspaces`, { cookie, body: { machine_id: machineId, local_path: '/data/app' } })).body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  const report = (facts: unknown) =>
    srv.request('POST', `/api/agent/workspaces/${wsId}/status`, { token: machineToken, body: { readiness: { overall: 'READY', checks: [] }, git: null, facts } });

  it('speichert Fakten bereinigt (keine Zugangsdaten in Hostnamen, nur Host-artige Variablen) und leitet daraus Komponenten ab', async () => {
    await report({
      env: [{ name: 'DATABASE_URL', host: 'postgresql://u:supergeheim@db.example.com:5432/x' }, { name: 'TELEGRAM_BOT_TOKEN', host: 'geheimer-token.de' }, { name: 'bad name!' }],
      markers: ['vercel.json'], packages: ['anthropic'], databases: [{ kind: 'sqlite', path: 'a.db', bytes: 1024 }],
    });
    const raw = srv.ctx.db.get<{ facts_json: string }>('SELECT facts_json FROM workspaces WHERE id = ?', wsId)!.facts_json;
    expect(raw).not.toContain('supergeheim');
    expect(raw).not.toContain('geheimer-token');
    expect(raw).toContain('db.example.com');
    const m = await model();
    expect(find(m, 'svc:telegram')).toBeTruthy();
    expect(find(m, 'svc:anthropic')).toBeTruthy();
    expect(find(m, 'hosting:vercel')).toBeTruthy();
    expect(find(m, 'dev:pc')).toBeTruthy();
    expect(find(m, 'repo')).toBeTruthy();
    expect(m.facts_at).toBeTruthy();
  });

  it('Manifest ergänzt Beschreibungen/Komponenten/Beziehungen; Fehler werden gemeldet', async () => {
    await report({
      env: [{ name: 'TELEGRAM_BOT_TOKEN' }], markers: [], packages: [], databases: [],
      architecture: { version: 1, components: [
        { id: 'telegram', kind: 'messaging', name: 'Telegram (Helferle-Bot)', description: 'Eigene Beschreibung', details: { Bot: '@helferle_bot' } },
        { id: 'server', kind: 'hosting', name: 'Linux-Server Renningen', provider: 'Debian', description: 'Läuft 24/7' },
        { id: 'osm', kind: 'map', name: 'OpenStreetMap', description: 'Kacheln' },
      ], links: [{ from: 'server', to: 'telegram', label: 'Polling' }, { from: 'server', to: 'osm', label: 'Karten' }, { from: 'ghost', to: 'osm', label: 'x' }] },
    });
    const m = await model();
    expect(find(m, 'svc:telegram')).toMatchObject({ name: 'Telegram (Helferle-Bot)', description: 'Eigene Beschreibung', source: 'manifest' });
    expect(find(m, 'svc:telegram').details[0]).toEqual({ label: 'Bot', value: '@helferle_bot' });
    expect(find(m, 'hosting:server')).toMatchObject({ provider: 'Debian', source: 'manifest' });
    expect(find(m, 'hosting:unknown')).toBeUndefined(); // Manifest legt Hosting fest → Platzhalter weg
    expect(m.links.some((l: any) => l.from === 'hosting:server' && l.to === 'svc:telegram' && l.label === 'Polling')).toBe(true);
    expect(m.links.some((l: any) => l.from === 'ghost')).toBe(false);
    expect(m.manifest).toEqual({ present: true, error: null });

    await report({ env: [], markers: [], packages: [], databases: [], architecture: { version: 9 } });
    expect((await model()).manifest.error).toContain('version');
  });

  it('manuelle Anpassungen: überschreiben, ausblenden, zurücksetzen, eigene Komponenten und Beziehungen; Viewer darf nicht', async () => {
    await report({ env: [{ name: 'TELEGRAM_BOT_TOKEN' }, { name: 'BREVO_API_KEY' }], markers: ['vercel.json'], packages: [], databases: [] });
    const put = (key: string, body: object) => srv.request('PUT', `${base()}/components/${encodeURIComponent(key)}`, { cookie, body });

    expect((await put('svc:telegram', { description: 'Meine Beschreibung' })).status).toBe(200);
    expect(find(await model(), 'svc:telegram')).toMatchObject({ description: 'Meine Beschreibung', source: 'manual', name: 'Telegram-Bot' });
    expect((await srv.request('DELETE', `${base()}/components/${encodeURIComponent('svc:telegram')}`, { cookie })).status).toBe(200);
    expect(find(await model(), 'svc:telegram').source).toBe('auto');

    await put('svc:brevo', { hidden: true });
    expect(find(await model(), 'svc:brevo')).toBeUndefined();

    const created = await srv.request('POST', `${base()}/components`, { cookie, body: { kind: 'service', name: 'Kunden-CRM', description: 'Adressen' } });
    expect(created.status).toBe(201);
    const crm = created.body.data.key;
    expect(crm).toMatch(/^manual:kunden-crm-/);
    expect((await srv.request('POST', `${base()}/links`, { cookie, body: { from: 'hosting:vercel', to: crm, label: 'synchronisiert' } })).status).toBe(201);
    expect((await model()).links.some((l: any) => l.to === crm && l.source === 'manual')).toBe(true);
    expect((await srv.request('POST', `${base()}/links`, { cookie, body: { from: 'hosting:vercel', to: 'gibt-es-nicht', label: 'x' } })).status).toBe(400);

    // automatische Beziehung ausblenden, manuelle löschen
    expect((await srv.request('DELETE', `${base()}/links`, { cookie, body: { from: 'dev:pc', to: 'repo', label: 'push / pull' } })).status).toBe(200);
    expect((await model()).links.some((l: any) => l.from === 'dev:pc' && l.to === 'repo')).toBe(false);
    expect((await srv.request('DELETE', `${base()}/links`, { cookie, body: { from: 'hosting:vercel', to: crm, label: 'synchronisiert' } })).status).toBe(200);
    expect((await model()).links.some((l: any) => l.to === crm)).toBe(false);

    // Viewer
    await srv.request('POST', '/api/users', { cookie, body: { email: 'v@x.test', password: 'viewer-pass-123', display_name: 'V', system_role: 'developer' } });
    await srv.request('POST', `/api/projects/${projectId}/members`, { cookie, body: { email: 'v@x.test', role: 'viewer' } });
    const vc = await srv.login('v@x.test', 'viewer-pass-123');
    expect((await srv.request('GET', base(), { cookie: vc })).status).toBe(200);
    expect((await srv.request('PUT', `${base()}/components/svc%3Atelegram`, { cookie: vc, body: { name: 'x' } })).status).toBe(403);
  });

  it('refresh beauftragt Prüfungen aller Workspaces (liefern frische Fakten)', async () => {
    srv.ctx.db.run('DELETE FROM agent_commands');
    const res = await srv.request('POST', `${base()}/refresh`, { cookie });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ requested: 1, workspaces: 1 });
  });
});
