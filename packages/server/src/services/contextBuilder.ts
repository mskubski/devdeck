import type { Database } from '../db/database.js';

/**
 * Baut die kompakten `.devdeck/`-Arbeitsdateien aus der SQLite Source of Truth
 * (Spezifikation §16/§22). Vollständige Historie bleibt in SQLite – diese Dateien
 * sind nur eine komprimierte Bridge für Coding Agents. SECRETS.md enthält NIE Werte.
 */
export interface ProjectContextInput {
  db: Database;
  projectId: string;
}

interface ProjectRow {
  name: string;
  slug: string;
  description: string | null;
  repo_remote: string | null;
  default_branch: string;
}

interface TaskRow {
  title: string;
  status: string;
  priority: number;
}

interface SessionRow {
  goal: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  user_email: string;
}

interface ChangelogRow {
  version: string | null;
  summary: string;
  created_at: string;
}

interface SecretRow {
  name: string;
  description: string | null;
  kind: string;
  environment: string;
}

export interface BuiltContext {
  'CONTEXT.md': string;
  'CURRENT_STATE.md': string;
  'CHANGELOG_RECENT.md': string;
  'SECRETS.md': string;
  'RULES.md': string;
}

function loadProject(db: Database, projectId: string): ProjectRow {
  const project = db.get<ProjectRow>(
    'SELECT name, slug, description, repo_remote, default_branch FROM projects WHERE id = ?',
    projectId,
  );
  if (!project) throw new Error(`Projekt ${projectId} nicht gefunden`);
  return project;
}

/** Arbeitsregeln für Coding Agents (landen lokal in `.claude/rules/devdeck.md`). */
function buildRulesMd(project: ProjectRow): string {
  return [
    `# DevDeck-Arbeitsregeln – ${project.name}`,
    '',
    '> Automatisch von DevDeck erzeugt (Workspace-Sync). Nicht bearbeiten – Änderungen werden überschrieben.',
    '',
    '## Projektkontext',
    '',
    'Lies zu Beginn jeder Sitzung `.devdeck/CONTEXT.md` und `.devdeck/CURRENT_STATE.md` (Entscheidungen, offene Tasks,',
    'bekannte Probleme). Secrets: In `.devdeck/SECRETS.md` stehen nur Namen – Werte niemals in Code, Logs oder Commits schreiben.',
    '',
    '## Nach jeder Code-Anpassung GitHub aktualisieren',
    '',
    '1. Build und Tests ausführen, falls vorhanden – nur bei Erfolg weitermachen.',
    `2. Committen und nach GitHub pushen (\`git push\`${project.repo_remote ? `, Remote: ${project.repo_remote}` : ''}).`,
    `   Ist \`${project.default_branch}\` geschützt (Pull Request/CI Pflicht): Feature-Branch pushen, Pull Request öffnen`,
    '   und Auto-Merge einschalten (`gh pr merge --auto --merge`).',
    '3. Keine uncommitteten Änderungen und keine unveröffentlichten Commits hinterlassen – sonst bricht der DevDeck-Sync ab',
    '   und andere Maschinen sehen den Stand nicht.',
    '4. Kein Force-Push, kein `--no-verify`.',
    '',
    '## Architektur-Karte pflegen',
    '',
    'DevDeck zeigt im Projekt-Dashboard eine Karte aller Komponenten (Entwicklung, GitHub, Betrieb/Hosting, Datenbank, externe Dienste wie',
    'Mail, Telegram, LLM-Anbieter, Karten) mit Beschreibungen und Beziehungen. Vieles erkennt DevDeck automatisch; Beschreibungen und',
    'Beziehungen stehen in **`.devdeck/architecture.yaml`** (versioniert, gehört ins Repository).',
    'Ändere oder ergänze diese Datei, sobald du **Datenbank, Hosting/Deployment oder einen externen Dienst** hinzufügst, wechselst oder entfernst',
    '(auch neue API-Keys/`.env`-Variablen für einen neuen Dienst) – im selben Commit wie die Code-Änderung. Format:',
    '',
    '```yaml',
    'version: 1',
    'components:',
    '  - id: telegram          # gleiche Kennung wie ein erkannter Dienst ergänzt diesen (telegram, mail, anthropic, supabase, …)',
    '    kind: messaging       # dev | repo | hosting | database | storage | service | llm | mail | messaging | map | payment | other',
    '    name: Telegram-Bot',
    '    provider: Telegram',
    '    description: Wofür wird der Dienst verwendet? (1–2 Sätze, für Nicht-Techniker verständlich)',
    '    details: { Bot: "@mein_bot" }   # optional, nur nicht-geheime Angaben (nie Passwörter/Tokens)',
    'links:',
    '  - from: server          # Kennung der Quelle',
    '    to: telegram          # Kennung des Ziels',
    '    label: Nachrichten    # kurze Beschriftung des Pfeils',
    '    description: Wie hängen beide zusammen?',
    '```',
    '',
    'Beschreibe zusätzlich, **wo die Anwendung läuft** (Komponente mit `kind: hosting`, z. B. eigener Server, Vercel, IONOS-Webspace) und welche',
    'Datenbank sie nutzt (Art, Standort/Region). Keine Geheimnisse in diese Datei schreiben.',
    '',
    '## Dokumentation',
    '',
    'Nutzersichtbare Änderungen in `CHANGELOG.md` festhalten.',
    '',
  ].join('\n');
}

function buildContextMd(db: Database, projectId: string, project: ProjectRow): string {
  const decisions = db.all<{ title: string; rationale: string | null }>(
    `SELECT title, rationale FROM decisions
     WHERE project_id = ? AND status = 'accepted' ORDER BY decided_at DESC LIMIT 15`,
    projectId,
  );
  const decisionLines = decisions.length
    ? ['## Getroffene Entscheidungen', '', ...decisions.map((d) => `- ${d.title}${d.rationale ? ` — ${d.rationale}` : ''}`), '']
    : [];
  return [
    `# ${project.name}`,
    '',
    project.description ? project.description : '_Keine Projektbeschreibung hinterlegt._',
    '',
    `- Slug: \`${project.slug}\``,
    `- Repository: ${project.repo_remote ?? '–'}`,
    `- Standard-Branch: \`${project.default_branch}\``,
    '',
    ...decisionLines,
    '> Diese Datei wird von DevDeck automatisch aus der zentralen Datenbank erzeugt ' +
      '(`context.refresh` / Workspace Sync). Änderungen hier werden beim nächsten Refresh überschrieben.',
    '',
  ].join('\n');
}

function buildCurrentStateMd(db: Database, projectId: string): string {
  const tasks = db.all<TaskRow>(
    `SELECT title, status, priority FROM tasks
     WHERE project_id = ? AND status IN ('open', 'in_progress')
     ORDER BY priority DESC, created_at DESC LIMIT 20`,
    projectId,
  );
  const sessions = db.all<SessionRow>(
    `SELECT cs.goal, cs.status, cs.started_at, cs.ended_at, u.email AS user_email
     FROM coding_sessions cs JOIN users u ON u.id = cs.user_id
     WHERE cs.project_id = ? ORDER BY cs.started_at DESC LIMIT 5`,
    projectId,
  );

  const lines: string[] = ['# Aktueller Stand', ''];
  lines.push('## Offene Tasks');
  if (tasks.length === 0) {
    lines.push('_Keine offenen Tasks._');
  } else {
    for (const t of tasks) {
      lines.push(`- [${t.status === 'in_progress' ? 'laufend' : 'offen'}] (P${t.priority}) ${t.title}`);
    }
  }
  const issues = db.all<{ title: string; severity: string }>(
    `SELECT title, severity FROM known_issues WHERE project_id = ? AND status = 'open'
     ORDER BY CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, created_at DESC LIMIT 15`,
    projectId,
  );
  lines.push('', '## Bekannte Probleme');
  if (issues.length === 0) lines.push('_Keine offenen bekannten Probleme._');
  for (const i of issues) lines.push(`- [${i.severity}] ${i.title}`);
  lines.push('', '## Letzte Coding Sessions');
  if (sessions.length === 0) {
    lines.push('_Noch keine Coding Sessions erfasst._');
  } else {
    for (const s of sessions) {
      const status = s.status === 'open' ? 'läuft' : 'abgeschlossen';
      lines.push(`- ${s.started_at} · ${s.user_email} · ${status} · ${s.goal ?? '(kein Ziel angegeben)'}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildChangelogMd(db: Database, projectId: string): string {
  const entries = db.all<ChangelogRow>(
    `SELECT version, summary, created_at FROM changelog_entries
     WHERE project_id = ? ORDER BY created_at DESC LIMIT 30`,
    projectId,
  );
  const lines: string[] = ['# Changelog (letzte Einträge)', ''];
  if (entries.length === 0) {
    lines.push('_Noch keine Changelog-Einträge._');
  } else {
    for (const e of entries) {
      lines.push(`- ${e.created_at}${e.version ? ` · ${e.version}` : ''} — ${e.summary}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildSecretsMd(db: Database, projectId: string): string {
  const secrets = db.all<SecretRow>(
    `SELECT name, description, kind, environment FROM secrets
     WHERE project_id = ? ORDER BY environment, name`,
    projectId,
  );
  const lines: string[] = [
    '# Secrets (nur Metadaten)',
    '',
    '> Diese Datei enthält NIEMALS Secret-Werte – nur Namen und Beschreibungen. ' +
      'Werte werden ausschließlich projiziert (`.env`, Secret Files) und niemals hier abgelegt.',
    '',
  ];
  if (secrets.length === 0) {
    lines.push('_Keine Secrets für dieses Projekt hinterlegt._');
  } else {
    for (const env of ['development', 'staging', 'production']) {
      const inEnv = secrets.filter((s) => s.environment === env);
      if (inEnv.length === 0) continue;
      lines.push(`## ${env}`, '');
      for (const s of inEnv) {
        lines.push(`- \`${s.name}\` (${s.kind})${s.description ? ` — ${s.description}` : ''}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** Erzeugt alle vier `.devdeck/`-Dateien für ein Projekt. */
export function buildProjectContext(input: ProjectContextInput): BuiltContext {
  const { db, projectId } = input;
  const project = loadProject(db, projectId);
  return {
    'CONTEXT.md': buildContextMd(db, projectId, project),
    'CURRENT_STATE.md': buildCurrentStateMd(db, projectId),
    'CHANGELOG_RECENT.md': buildChangelogMd(db, projectId),
    'SECRETS.md': buildSecretsMd(db, projectId),
    'RULES.md': buildRulesMd(project),
  };
}
