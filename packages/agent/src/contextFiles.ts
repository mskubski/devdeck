import fs from 'node:fs';
import path from 'node:path';

/** Nur generierte Dateien ausschließen; `.devdeck/workspace.yaml` und `.devdeck/architecture.yaml` gehören ins Repo. */
export const GENERATED_PATTERNS = [
  '.devdeck/CONTEXT.md', '.devdeck/CURRENT_STATE.md', '.devdeck/CHANGELOG_RECENT.md', '.devdeck/SECRETS.md',
  '.devdeck/RULES.md', '.devdeck/state.json', '.devdeck/project.json', '.devdeck/session.json', '.devdeck/handover/',
];

const RULES_MARKER_IN_REPO = 'devdeck:rules-included';

/** Lokal (nur in dieser Arbeitskopie) ignorieren, ohne eine versionierte Datei zu verändern. */
export function ensureGitExclude(workspacePath: string, patterns: string[]): void {
  const gitDir = path.join(workspacePath, '.git');
  try {
    if (!fs.statSync(gitDir).isDirectory()) return; // Worktree/Submodul: nicht anfassen
  } catch {
    return;
  }
  const file = path.join(gitDir, 'info', 'exclude');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* noch nicht vorhanden */
  }
  // Frühere Agent-Versionen haben pauschal `.devdeck/` ausgeschlossen – das würde versionierte Dateien wie
  // `.devdeck/architecture.yaml` verstecken. Diese Zeile (nur in unserem Block) wird entfernt.
  if (current.includes('# DevDeck (lokal, nicht versioniert)') && patterns.every((p) => p !== '.devdeck/')) {
    const cleaned = current.replace(/^\.devdeck\/\r?\n/m, '');
    if (cleaned !== current) {
      current = cleaned;
      fs.writeFileSync(file, current);
    }
  }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !have.has(p));
  if (missing.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}# DevDeck (lokal, nicht versioniert)\n${missing.join('\n')}\n`);
}

/**
 * Coding-Regeln für Claude Code bereitstellen: `.claude/rules/devdeck.md` wird von Claude Code beim Start
 * geladen. Die Datei bleibt UNVERSIONIERT (lokaler git-Exclude), damit das Repository nicht „dirty“ wird und
 * der Sync nicht abbricht. Enthält das Repo bereits eigene Regeln (CLAUDE.md mit Marker), wird nichts geschrieben.
 */
export function installClaudeRules(workspacePath: string, rules: string | undefined): boolean {
  if (!rules) return false;
  try {
    const claudeMd = fs.readFileSync(path.join(workspacePath, 'CLAUDE.md'), 'utf8');
    if (claudeMd.includes(RULES_MARKER_IN_REPO)) return false;
  } catch {
    /* keine CLAUDE.md – normal */
  }
  const target = path.join(workspacePath, '.claude', 'rules', 'devdeck.md');
  try {
    if (fs.readFileSync(target, 'utf8') === rules) {
      ensureGitExclude(workspacePath, ['.claude/rules/devdeck.md']);
      return false;
    }
  } catch {
    /* noch nicht vorhanden */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rules, 'utf8');
  ensureGitExclude(workspacePath, ['.claude/rules/devdeck.md']);
  return true;
}

/** Vom Server erzeugte Kontextdateien nach `.devdeck/` schreiben (und Regeln für Claude Code installieren). */
export function writeContextFiles(workspacePath: string, files: Record<string, string>): string[] {
  const target = path.join(workspacePath, '.devdeck');
  fs.mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    if (!/^[A-Z_]+\.md$/.test(name) || typeof content !== 'string') continue; // nur erwartete Kontextdateien
    fs.writeFileSync(path.join(target, name), content, 'utf8');
    written.push(name);
  }
  fs.mkdirSync(path.join(target, 'handover'), { recursive: true });
  // Generierter Kontext gehört nicht in die Versionierung und darf den Sync nicht blockieren
  ensureGitExclude(workspacePath, GENERATED_PATTERNS);
  installClaudeRules(workspacePath, files['RULES.md']);
  return written;
}
