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

/** Keep-a-Changelog-ähnlich: `## <Version/Unreleased> - <Datum>`, `### Added`, Bullets. */
export function parseChangelog(md: string): ChangelogItem[] {
  const items: ChangelogItem[] = [];
  let version: string | null = null;
  let date: string | null = null;
  let section: string | null = null;
  let current: string[] | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = stripMd(current.join(' ').replace(/\s+/g, ' '));
    if (text) {
      const first = current[0] ? stripMd(current[0]) : text;
      const summary = (first.length > 200 ? `${first.slice(0, 197)}…` : first);
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
    const h2 = /^##\s+(?!#)(.+)$/.exec(raw);
    if (h2) {
      flush();
      section = null;
      const heading = h2[1]!.replace(/[[\]]/g, '').trim();
      const dm = /(\d{4}-\d{2}-\d{2})/.exec(heading);
      date = dm ? dm[1]! : null;
      const label = heading.replace(/\d{4}-\d{2}-\d{2}/, '').replace(/^\s*(version)\s+/i, '').replace(/[\s\-–—(),]+$/g, '').replace(/^[\s\-–—]+/, '').trim();
      version = label || null;
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(raw);
    if (h3) {
      flush();
      section = h3[1]!.trim();
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      flush();
      current = [bullet[1]!];
      continue;
    }
    if (current && /^\s+\S/.test(raw)) current.push(raw.trim());
    else if (!raw.trim()) flush();
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

/** Checkbox-Listen (`- [ ]` / `- [x]`), Abschnittsüberschrift wird Kontext, `(P1..P5)` setzt die Priorität. */
export function parseTasks(md: string): TaskItem[] {
  const out: TaskItem[] = [];
  let section: string | null = null;
  for (const raw of md.split(/\r?\n/)) {
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
