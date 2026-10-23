import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from '../../server/test/helpers.js';
import { main } from '../src/index.js';
import { parseChangelog, parseSecrets, parseTasks } from '@devdeck/shared';

describe('Import-Parser', () => {
  it('parseChangelog: Versionen, Datum, Abschnitte, mehrzeilige Bullets', () => {
    const items = parseChangelog(`# Changelog

## Unreleased - 2026-10-08

### Added
- Context-Builder (\`contextBuilder.ts\`):
  \`.devdeck/CONTEXT.md\` wird live erzeugt.
- Neue UI

### Fixed
- Bug **A**

## Version 1.0.0 - 2026-10-06

### Added
- Erster Release
`);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ version: 'Unreleased', date: '2026-10-08', summary: 'Added: Context-Builder (contextBuilder.ts):' });
    expect(items[0]!.body).toContain('live erzeugt');
    expect(items[2]).toMatchObject({ summary: 'Fixed: Bug A' });
    expect(items[3]).toMatchObject({ version: '1.0.0', date: '2026-10-06' });
  });

  it('parseTasks: Checkboxen, Status, Priorität, Abschnitt', () => {
    const items = parseTasks(`## Offen\n- [ ] Backups testen (P5)\n- [x] CLI bauen\nkein Task\n* [ ] **Fett** Task\n`);
    expect(items).toEqual([
      { title: 'Backups testen', done: false, priority: 5, section: 'Offen' },
      { title: 'CLI bauen', done: true, priority: 3, section: 'Offen' },
      { title: 'Fett Task', done: false, priority: 3, section: 'Offen' },
    ]);
  });

  it('parseSecrets: .env mit Quotes/Kommentaren/Platzhaltern', () => {
    const items = parseSecrets(`# kommentar\nA_KEY=abc123\nexport B_KEY="mit leerzeichen"  \nC_KEY='x' # c\nD_KEY=\nE_KEY=changeme\nF_KEY=<your-key>\nlower=ignored\nG=1 # inline\n`, 'env');
    expect(items).toEqual([
      { name: 'A_KEY', value: 'abc123' },
      { name: 'B_KEY', value: 'mit leerzeichen' },
      { name: 'C_KEY', value: 'x' },
      { name: 'G', value: '1' },
    ]);
  });

  it('parseSecrets: credentials.md (KEY: value, **KEY**: value, Tabelle) ohne Fließtext-Treffer', () => {
    const items = parseSecrets(`# Zugänge\nDies ist: Fließtext\n- SUPABASE_URL: https://x.supabase.co\n**API_TOKEN**: tok_123\n| Name | Wert |\n|---|---|\n| STRIPE_KEY | sk_live_1 |\n\`\`\`\nDB_PASSWORD=pw\n\`\`\`\n`, 'md');
    expect(items.map((i) => i.name).sort()).toEqual(['API_TOKEN', 'DB_PASSWORD', 'STRIPE_KEY', 'SUPABASE_URL']);
    expect(items.find((i) => i.name === 'SUPABASE_URL')!.value).toBe('https://x.supabase.co');
  });
});

describe('devdeck import', () => {
  let srv: TestServer;
  let cookie: string;
  let tmp: string;
  let ws: string;
  let projectId: string;
  let out: string[];
  const run = (argv: string[]) =>
    main(argv, {
      env: {
        ...process.env,
        DEVDECK_CLI_CONFIG: path.join(tmp, 'cli.json'),
        DEVDECK_AGENT_CONFIG: path.join(tmp, 'none.json'),
        DEVDECK_SERVER: srv.base,
        DEVDECK_EMAIL: TEST_ADMIN.email,
        DEVDECK_PASSWORD: TEST_ADMIN.password,
      },
      cwd: ws,
      io: { out: (l) => out.push(l), err: (l) => out.push(l), prompt: async () => '' },
    });

  beforeEach(async () => {
    srv = await startTestServer();
    cookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-imp-'));
    ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(ws, '.devdeck'), { recursive: true });
    projectId = (await srv.request('POST', '/api/projects', { cookie, body: { name: 'Imp' } })).body.data.id;
    fs.writeFileSync(path.join(ws, '.devdeck', 'project.json'), JSON.stringify({ project_id: projectId }));
    fs.writeFileSync(path.join(ws, 'CHANGELOG.md'), '## 1.0.0 - 2026-10-06\n\n### Added\n- Erster Release\n- Zweiter Punkt\n');
    fs.writeFileSync(path.join(ws, 'ROADMAP.md'), '## Plan\n- [x] Fertig\n- [ ] Offen (P4)\n');
    fs.writeFileSync(path.join(ws, '.env'), 'MY_KEY=geheim-wert-1\nOTHER=zwei\n');
    out = [];
    await run(['login']);
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Vorschau schreibt nichts und zeigt keine Secret-Werte', async () => {
    expect(await run(['import', 'all'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Vorschau');
    expect(text).toContain('MY_KEY');
    expect(text).not.toContain('geheim-wert-1');
    expect((await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data).toHaveLength(0);
    expect((await srv.request('GET', `/api/projects/${projectId}/changelog`, { cookie })).body.data).toHaveLength(0);
  });

  it('--apply importiert Changelog (mit Datum), Tasks (mit Status) und Secrets – idempotent', async () => {
    expect(await run(['import', 'all', '--apply'])).toBe(0);
    expect(out.join('\n')).not.toContain('geheim-wert-1');

    const log = (await srv.request('GET', `/api/projects/${projectId}/changelog`, { cookie })).body.data;
    expect(log).toHaveLength(2);
    expect(log[0].created_at.startsWith('2026-10-06')).toBe(true);
    const tasks = (await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data;
    expect(tasks.find((t: any) => t.title === 'Fertig')).toMatchObject({ status: 'done' });
    expect(tasks.find((t: any) => t.title === 'Fertig').closed_at).toBeTruthy();
    expect(tasks.find((t: any) => t.title === 'Offen')).toMatchObject({ status: 'open', priority: 4 });
    const secrets = (await srv.request('GET', `/api/projects/${projectId}/secrets`, { cookie })).body.data;
    expect(secrets.map((s: any) => s.name).sort()).toEqual(['MY_KEY', 'OTHER']);
    const mine = secrets.find((s: any) => s.name === 'MY_KEY');
    const val = await srv.request('GET', `/api/projects/${projectId}/secrets/${mine.id}/values`, { cookie });
    expect(val.body.data.value).toBe('geheim-wert-1');

    // Zweiter Lauf: nichts doppelt
    out.length = 0;
    await run(['import', 'all', '--apply']);
    expect((await srv.request('GET', `/api/projects/${projectId}/changelog`, { cookie })).body.data).toHaveLength(2);
    expect((await srv.request('GET', `/api/projects/${projectId}/tasks`, { cookie })).body.data).toHaveLength(2);
    expect((await srv.request('GET', `/api/projects/${projectId}/secrets`, { cookie })).body.data).toHaveLength(2);
  });

  it('--create erzeugt ROADMAP.md aus DevDeck-Tasks, wenn keine Datei existiert', async () => {
    fs.rmSync(path.join(ws, 'ROADMAP.md'));
    await srv.request('POST', `/api/projects/${projectId}/tasks`, { cookie, body: { title: 'Alt', priority: 5 } });
    await run(['import', 'tasks', '--create', '--apply']);
    expect(fs.readFileSync(path.join(ws, 'ROADMAP.md'), 'utf8')).toContain('- [ ] Alt (P5)');
  });
});

describe('Import-Parser: weitere Formate (Roadmap ohne Checkboxen, Datumsüberschriften)', () => {
  it('parseTasks: Listen ohne Checkboxen; ✅, Durchgestrichen und „Erledigt“-Abschnitt = erledigt; Hinweise ignoriert', () => {
    const items = parseTasks(`# Roadmap\n\n## Hinweis\n- das ist nur eine Notiz\n\n## Geplant\n- Instagram-Publisher\n- TikTok-Anbindung (P5)\n\n## Erledigt\n- Telegram-Bot\n- Web-GUI ✅\n\n## Weiteres\n- ~~Alte Idee~~\n- Instagram-Publisher\n  - Unterpunkt wird ignoriert\n`);
    expect(items).toEqual([
      { title: 'Instagram-Publisher', done: false, priority: 3, section: 'Geplant' },
      { title: 'TikTok-Anbindung', done: false, priority: 5, section: 'Geplant' },
      { title: 'Telegram-Bot', done: true, priority: 3, section: 'Erledigt' },
      { title: 'Web-GUI', done: true, priority: 3, section: 'Erledigt' },
      { title: 'Alte Idee', done: true, priority: 3, section: 'Weiteres' },
    ]);
  });

  it('parseChangelog: Datumsüberschriften (ISO und deutsch), Absätze, nummerierte Listen, Titel und Trennlinien ignoriert', () => {
    const items = parseChangelog(`# Changelog\n\nEinleitungstext wird ignoriert.\n\n---\n\n## 23.10.2026\n\nTikTok-Publisher hinzugefügt.\nMit Warteschlange.\n\n1. Fix für Selbstheilung\n\n### 2026-10-20\n- Insta/FB-Freigabe\n\n\`\`\`\n- im Codeblock\n\`\`\`\n`);
    expect(items.map((i) => [i.version, i.date, i.summary])).toEqual([
      [null, '2026-10-23', 'TikTok-Publisher hinzugefügt.'],
      [null, '2026-10-23', 'Fix für Selbstheilung'],
      [null, '2026-10-20', 'Insta/FB-Freigabe'],
    ]);
  });
});
