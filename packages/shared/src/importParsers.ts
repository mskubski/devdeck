/**
 * Parser für den Import vorhandener Projektinformationen (CHANGELOG.md, ROADMAP/TODO.md,
 * .env / credentials.md). Rein funktional und ohne I/O – gut testbar.
 */

export interface ChangelogItem {
  version: string | null;
  /** YYYY-MM-DD oder null */
  date: string | null;
  summary: string;
  body: string | null;
}

const stripMd = (s: string): string =>
  s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

const VERSIONISH = /(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}|\bv?\d+\.\d+(?:\.\d+)?\b|unreleased|unveröffentlicht)/i;

function headingDate(text: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
  if (de) return `${de[3]}-${de[2]!.padStart(2, '0')}-${de[1]!.padStart(2, '0')}`;
  return null;
}

/**
 * Changelogs im Keep-a-Changelog-Stil und typische Varianten: Überschriften mit Version und/oder Datum
 * (`## 1.2.0 - 2026-10-01`, `## [Unreleased]`, `### 23.10.2026`), darunter Bullets, nummerierte Listen oder
 * Fließtext-Absätze; Unterüberschriften (`### Added`) werden dem Eintrag vorangestellt.
 */
export function parseChangelog(md: string): ChangelogItem[] {
  const items: ChangelogItem[] = [];
  let version: string | null = null;
  let date: string | null = null;
  let section: string | null = null;
  let seenVersion = false;
  let current: string[] | null = null;
  let inFence = false;

  const flush = (): void => {
    if (!current) return;
    const text = stripMd(current.join(' ').replace(/\s+/g, ' '));
    if (text) {
      const first = current[0] ? stripMd(current[0]) : text;
      const summary = first.length > 200 ? `${first.slice(0, 197)}…` : first;
      const rest = text === summary ? '' : text;
      items.push({
        version,
        date,
        summary: section ? `${section}: ${summary}` : summary,
        body: rest || null,
      });
    }
    current = null;
  };

  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      const text = heading[2]!.replace(/[[\]]/g, '').trim();
      if (level <= 3 && VERSIONISH.test(text)) {
        seenVersion = true;
        section = null;
        date = headingDate(text);
        const label = text
          .replace(/\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/, '')
          .replace(/^\s*(version|release)\s+/i, '')
          .replace(/[\s\-–—(),:]+$/g, '')
          .replace(/^[\s\-–—:]+/, '')
          .trim();
        version = label || null;
      } else if (level >= 3 || (level === 2 && seenVersion)) {
        section = text;
      } else {
        section = null;
      }
      continue;
    }
    if (/^\s*([-*_]{3,}|<!--.*|\|.*|>.*)\s*$/.test(raw)) {
      flush();
      continue;
    }
    const bullet = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      flush();
      current = [bullet[1]!];
      continue;
    }
    if (!raw.trim()) {
      flush();
      continue;
    }
    if (current) current.push(raw.trim()); // eingerückte Fortsetzung oder weitere Zeile desselben Absatzes
    else if (seenVersion) current = [raw.trim()]; // Fließtext-Absatz unter einer Versionsüberschrift
  }
  flush();
  return items;
}

export interface TaskItem {
  title: string;
  done: boolean;
  priority: number;
  section: string | null;
}

const DONE_SECTION = /erledigt|fertig|done|umgesetzt|abgeschlossen|implemented|completed/i;
const NOTE_SECTION = /hinweis|notiz|legende|kontext|überblick|einleitung|info\b/i;

/**
 * Checkbox-Listen (`- [ ]` / `- [x]`); Abschnittsüberschrift wird Kontext, `(P1..P5)` setzt die Priorität.
 * Enthält die Datei keine Checkboxen (z. B. eine reine Roadmap-Liste), werden ersatzweise die Bullets der obersten
 * Ebene als Tasks gelesen: ✅/durchgestrichen oder eine Überschrift wie „Erledigt“ markiert sie als erledigt.
 */
export function parseTasks(md: string): TaskItem[] {
  const out: TaskItem[] = [];
  let section: string | null = null;
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (inFence) continue;
    const h = /^#{1,6}\s+(.+)$/.exec(raw);
    if (h) {
      section = stripMd(h[1]!);
      continue;
    }
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(raw);
    if (!m) continue;
    let title = stripMd(m[2]!);
    let priority = 3;
    const p = /\s*\(P([1-5])\)\s*$/.exec(title);
    if (p) {
      priority = Number(p[1]);
      title = title.slice(0, p.index).trim();
    }
    if (title) out.push({ title: title.slice(0, 300), done: m[1] !== ' ', priority, section });
  }
  if (out.length > 0) return out;

  // Fallback: einfache Listen ohne Checkboxen
  section = null;
  inFence = false;
  const seen = new Set<string>();
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (inFence) continue;
    const h = /^#{1,6}\s+(.+)$/.exec(raw);
    if (h) {
      section = stripMd(h[1]!);
      continue;
    }
    const m = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(raw); // nur oberste Ebene (kein Einzug)
    if (!m || (section && NOTE_SECTION.test(section))) continue;
    const text = m[1]!;
    const struck = /~~.+~~/.test(text);
    const marked = /[✅☑✔]/.test(text);
    let title = stripMd(text.replace(/~~/g, '').replace(/[✅☑✔⬜☐🔲⏳🚧]/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    const p = /\s*\(P([1-5])\)\s*$/.exec(title);
    let priority = 3;
    if (p) {
      priority = Number(p[1]);
      title = title.slice(0, p.index).trim();
    }
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push({
      title: title.slice(0, 300),
      done: struck || marked || Boolean(section && DONE_SECTION.test(section)),
      priority,
      section,
    });
  }
  return out;
}

export interface SecretItem {
  name: string;
  value: string;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MD_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const PLACEHOLDER = /^(<.*>|\$\{.*\}|\{\{.*\}\}|changeme|change[-_ ]?me|xxx+|your[-_].*|todo|example.*|\.\.\.|\*+|-|none|null|tbd)$/i;

function cleanValue(v: string): string {
  let value = v.trim();
  const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
  if (quoted) {
    value = quoted[2]!;
  } else {
    value = value.replace(/\s+#.*$/, '').trim(); // Inline-Kommentar nur bei unquotierten Werten
  }
  return value.replace(/^`(.*)`$/, '$1').trim();
}

/**
 * `.env`-Dateien: `KEY=VALUE`, optional `export`. `kind: 'md'` ist für credentials.md toleranter
 * (`KEY=VALUE`, `KEY: value`, `**KEY**: value`, Tabellenzeilen) und verlangt GROSSGESCHRIEBENE Namen,
 * um Fließtext nicht fälschlich als Secret zu erkennen. Leere Werte und Platzhalter werden verworfen.
 */
export function parseSecrets(text: string, kind: 'env' | 'md'): SecretItem[] {
  const found = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;
    let name: string | undefined;
    let value: string | undefined;

    const kv = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.replace(/^[-*]\s+/, ''));
    if (kv) {
      name = kv[1];
      value = kv[2];
    } else if (kind === 'md') {
      const table = /^\|\s*`?([A-Za-z][A-Za-z0-9_]*)`?\s*\|\s*`?([^|]*?)`?\s*\|/.exec(line);
      const colon = /^[-*]?\s*\**`?([A-Za-z][A-Za-z0-9_]*)`?\**\s*:\s*(.+)$/.exec(line);
      const m = table ?? colon;
      if (m) {
        name = m[1];
        value = m[2];
      }
    }
    if (!name || value === undefined) continue;
    if (!(kind === 'env' ? ENV_NAME : MD_NAME).test(name)) continue;
    const cleaned = cleanValue(value);
    if (!cleaned || PLACEHOLDER.test(cleaned)) continue;
    found.set(name, cleaned); // spätere Definition gewinnt (wie bei dotenv)
  }
  return [...found].map(([name, value]) => ({ name, value }));
}
