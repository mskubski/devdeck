import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collectFacts } from '../src/facts.js';
import { ensureGitExclude, GENERATED_PATTERNS } from '../src/contextFiles.js';

describe('Fakten für die Architektur-Karte (Agent)', () => {
  let dir: string;
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-facts-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('liest Variablennamen und nur bereinigte Hostnamen – nie Geheimnisse', () => {
    write('.env', [
      'TELEGRAM_BOT_TOKEN=1234:SUPERGEHEIM',
      'EMAIL_PASS=passwort123',
      'IMAP_HOST=imap.ionos.de',
      'DATABASE_URL=postgresql://user:dbpasswort@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
      'ANTHROPIC_MODEL=claude-sonnet',
      '# SMTP_HOST=auskommentiert.example.com',
      'export WEBSERVER_HOST=home1.1and1-data.host',
    ].join('\n'));
    write('.env.example', 'NEU_NUR_IM_BEISPIEL=\nIMAP_HOST=your-host\n');
    const facts = collectFacts(dir);
    const names = facts.env.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['TELEGRAM_BOT_TOKEN', 'EMAIL_PASS', 'IMAP_HOST', 'DATABASE_URL', 'NEU_NUR_IM_BEISPIEL']));
    expect(names).not.toContain('SMTP_HOST');
    expect(facts.env.find((e) => e.name === 'IMAP_HOST')?.host).toBe('imap.ionos.de');
    expect(facts.env.find((e) => e.name === 'DATABASE_URL')?.host).toBe('aws-0-eu-central-1.pooler.supabase.com');
    expect(facts.env.find((e) => e.name === 'WEBSERVER_HOST')?.host).toBe('home1.1and1-data.host');
    const json = JSON.stringify(facts);
    for (const secret of ['SUPERGEHEIM', 'passwort123', 'dbpasswort', 'claude-sonnet', 'your-host']) expect(json).not.toContain(secret);
  });

  it('erkennt Pakete, Marker und SQLite-Dateien (ohne node_modules/.git)', () => {
    write('package.json', JSON.stringify({ dependencies: { '@supabase/supabase-js': '^2', Express: '4' }, devDependencies: { vitest: '5' } }));
    write('requirements.txt', 'python-telegram-bot==20.1\n# Kommentar\nanthropic>=0.30\n-r other.txt\nMistralAI\n');
    write('vercel.json', '{}');
    write('Dockerfile', 'FROM node');
    write('deploy/app.service', '[Unit]');
    write('data/app.db', 'x'.repeat(2048));
    write('node_modules/x/cache.db', 'zzz');
    write('.git/objects/y.sqlite', 'zzz');
    const facts = collectFacts(dir);
    expect(facts.packages).toEqual(expect.arrayContaining(['@supabase/supabase-js', 'express', 'vitest', 'python-telegram-bot', 'anthropic', 'mistralai']));
    expect(facts.markers).toEqual(expect.arrayContaining(['vercel.json', 'Dockerfile', 'systemd']));
    expect(facts.databases).toEqual([{ kind: 'sqlite', path: 'data/app.db', bytes: 2048 }]);
  });

  it('liest und validiert .devdeck/architecture.yaml; Fehler werden gemeldet statt zu werfen', () => {
    write('.devdeck/architecture.yaml', 'version: 1\ncomponents:\n  - id: telegram\n    kind: messaging\n    name: Telegram\n    description: Bot\nlinks:\n  - from: app\n    to: telegram\n    label: Nachrichten\n');
    let facts = collectFacts(dir);
    expect(facts.architecture?.components[0]).toMatchObject({ id: 'telegram', kind: 'messaging' });
    expect(facts.architecture_error).toBeNull();

    write('.devdeck/architecture.yaml', 'version: 1\ncomponents:\n  - id: x\n    kind: kaputt\n    name: X\n');
    facts = collectFacts(dir);
    expect(facts.architecture).toBeNull();
    expect(facts.architecture_error).toContain('kind');

    write('.devdeck/architecture.yaml', 'a: [unclosed');
    expect(collectFacts(dir).architecture_error).toContain('YAML');
  });

  it('Git-Exclude: nur generierte Dateien, architecture.yaml bleibt versionierbar; alte pauschale Zeile wird migriert', () => {
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '# eigene Zeile\n*.log\n# DevDeck (lokal, nicht versioniert)\n.devdeck/\n.claude/rules/devdeck.md\n');
    ensureGitExclude(dir, GENERATED_PATTERNS);
    const text = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(text).toContain('*.log');
    expect(text).not.toMatch(/^\.devdeck\/$/m);
    expect(text).toContain('.devdeck/CONTEXT.md');
    expect(text).not.toContain('architecture.yaml');
    expect(text.match(/\.claude\/rules\/devdeck\.md/g)).toHaveLength(1);
  });

  it('das mitgelieferte .devdeck/architecture.yaml von DevDeck selbst ist gültig', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const facts = collectFacts(repoRoot);
    expect(facts.architecture_error).toBeNull();
    expect(facts.architecture?.components.map((c) => c.id)).toEqual(expect.arrayContaining(['debian01', 'devdeck-db']));
  });
});
