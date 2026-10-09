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
}

function loadProject(db: Database, projectId: string): ProjectRow {
  const project = db.get<ProjectRow>(
    'SELECT name, slug, description, repo_remote, default_branch FROM projects WHERE id = ?',
    projectId,
  );
  if (!project) throw new Error(`Projekt ${projectId} nicht gefunden`);
  return project;
}

function buildContextMd(project: ProjectRow): string {
  return [
    `# ${project.name}`,
    '',
    project.description ? project.description : '_Keine Projektbeschreibung hinterlegt._',
    '',
    `- Slug: \`${project.slug}\``,
    `- Repository: ${project.repo_remote ?? '–'}`,
    `- Standard-Branch: \`${project.default_branch}\``,
    '',
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
    'CONTEXT.md': buildContextMd(project),
    'CURRENT_STATE.md': buildCurrentStateMd(db, projectId),
    'CHANGELOG_RECENT.md': buildChangelogMd(db, projectId),
    'SECRETS.md': buildSecretsMd(db, projectId),
  };
}
