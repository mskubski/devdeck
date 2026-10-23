import fs from 'node:fs';
import path from 'node:path';

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
  ensureGitExclude(workspacePath, ['.devdeck/']);
  installClaudeRules(workspacePath, files['RULES.md']);
  return written;
}
