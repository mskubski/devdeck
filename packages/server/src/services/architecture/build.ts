import type {
  ArchComponent, ArchDetail, ArchLink, ArchManifest, ArchModel, GitState, WorkspaceFacts,
} from '@devdeck/shared';
import { isArchKind } from '@devdeck/shared';
import type { AppContext } from '../../context.js';
import { deriveArchitecture } from './derive.js';

interface WsRow {
  id: string;
  local_path: string;
  branch: string | null;
  status: string;
  git_json: string | null;
  checked_at: string | null;
  facts_json: string | null;
  facts_at: string | null;
  machine_name: string | null;
  agent_status: string | null;
}

const parse = <T>(v: string | null | undefined): T | null => {
  try {
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};

/** Schlüssel einer Manifest-Komponente: gleiche Kennung wie die automatisch erkannte, damit beide zusammengeführt werden. */
export function manifestKey(id: string, kind: string): string {
  if (id.includes(':')) return id;
  switch (kind) {
    case 'dev': return `dev:${id}`;
    case 'repo': return 'repo';
    case 'hosting': return `hosting:${id}`;
    case 'database': case 'storage': return `db:${id}`;
    default: return `svc:${id}`;
  }
}

const detailsFromRecord = (r: Record<string, string> | undefined): ArchDetail[] =>
  Object.entries(r ?? {}).map(([label, value]) => ({ label, value }));

/** Gesamtmodell: automatisch erkannt → Manifest (.devdeck/architecture.yaml) → manuelle Anpassungen im UI. */
export function buildArchitecture(ctx: AppContext, projectId: string): ArchModel {
  const { db } = ctx;
  const project = db.get<{ name: string; repo_remote: string | null; default_branch: string | null }>(
    'SELECT name, repo_remote, default_branch FROM projects WHERE id = ?', projectId,
  )!;
  const rows = db.all<WsRow>(
    `SELECT w.id, w.local_path, w.branch, w.status, w.git_json, w.checked_at, w.facts_json, w.facts_at,
            m.name AS machine_name, m.agent_status
     FROM workspaces w LEFT JOIN machines m ON m.id = w.machine_id
     WHERE w.project_id = ? ORDER BY w.created_at`, projectId,
  );
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const sessionCount = (wsId: string): number =>
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM coding_sessions WHERE workspace_id = ? AND source = 'claude-code' AND started_at > ?`, wsId, since,
    )?.n ?? 0;

  // Fakten aller Workspaces zusammenführen; das Manifest der zuletzt erhobenen Fakten gilt
  const facts: Pick<WorkspaceFacts, 'env' | 'markers' | 'packages' | 'databases'> = { env: [], markers: [], packages: [], databases: [] };
  let manifest: ArchManifest | null = null;
  let manifestError: string | null = null;
  let factsAt: string | null = null;
  const seenEnv = new Map<string, { name: string; host?: string }>();
  for (const w of [...rows].sort((a, b) => (a.facts_at ?? '').localeCompare(b.facts_at ?? ''))) {
    const f = parse<WorkspaceFacts>(w.facts_json);
    if (!f) continue;
    for (const e of f.env) if (!seenEnv.has(e.name) || (!seenEnv.get(e.name)!.host && e.host)) seenEnv.set(e.name, e);
    facts.markers.push(...f.markers);
    facts.packages.push(...f.packages);
    facts.databases.push(...f.databases);
    if (f.architecture) { manifest = f.architecture; manifestError = null; }
    else if (f.architecture_error) manifestError = f.architecture_error;
    factsAt = w.facts_at;
  }
  facts.env = [...seenEnv.values()];
  facts.markers = [...new Set(facts.markers)];
  facts.packages = [...new Set(facts.packages)];

  const secretNames = db.all<{ name: string }>('SELECT DISTINCT name FROM secrets WHERE project_id = ?', projectId).map((s) => s.name);
  const connectors = db.all<{ type: string; name: string; last_check_ok: number | null; last_check_message: string | null }>(
    'SELECT type, name, last_check_ok, last_check_message FROM project_connectors WHERE project_id = ?', projectId,
  ).map((c) => ({ ...c, last_check_ok: c.last_check_ok === null ? null : Boolean(c.last_check_ok) }));

  const derived = deriveArchitecture({
    project,
    workspaces: rows.filter((w) => w.machine_name).map((w) => ({
      machine_name: w.machine_name!,
      machine_online: w.agent_status === 'online',
      local_path: w.local_path,
      branch: w.branch,
      status: w.status,
      git: parse<GitState>(w.git_json),
      checked_at: w.checked_at,
      claude_sessions_30d: sessionCount(w.id),
    })),
    secretNames, facts, connectors,
  });

  const comps = new Map<string, ArchComponent>(derived.components.map((c) => [c.key, c]));
  const links = new Map<string, ArchLink>(derived.links.map((l) => [l.id, l]));

  // Manifest überlagert die Automatik (Beschreibungen, Namen, Details, zusätzliche Komponenten/Beziehungen)
  const resolveRef = (ref: string): string | null => {
    for (const k of [ref, `dev:${ref}`, 'repo', `hosting:${ref}`, `db:${ref}`, `svc:${ref}`]) {
      if (k === 'repo' && ref !== 'repo' && ref !== 'github' && ref !== 'gitlab') continue;
      if (comps.has(k)) return k;
    }
    return null;
  };
  if (manifest) {
    const m = manifest as ArchManifest;
    const idToKey = new Map<string, string>();
    for (const c of m.components) {
      const key = manifestKey(c.id, c.kind);
      idToKey.set(c.id, key);
      const existing = comps.get(key);
      const details = detailsFromRecord(c.details);
      comps.set(key, {
        key,
        kind: c.kind,
        name: c.name,
        provider: c.provider ?? existing?.provider ?? null,
        description: c.description ?? existing?.description ?? null,
        details: details.length ? [...details, ...(existing?.details ?? []).filter((d) => !details.some((x) => x.label === d.label))] : existing?.details ?? [],
        source: 'manifest',
        ...(existing?.status ? { status: existing.status } : {}),
      });
    }
    for (const l of m.links) {
      const from = idToKey.get(l.from) ?? resolveRef(l.from);
      const to = idToKey.get(l.to) ?? resolveRef(l.to);
      if (!from || !to) continue;
      const id = `${from}>${to}|${l.label}`;
      links.set(id, { id, from, to, label: l.label, description: l.description ?? null, source: 'manifest' });
    }
    // Beschreibt das Manifest ein Hosting, ist der Platzhalter überflüssig
    if ([...comps.values()].some((c) => c.kind === 'hosting' && !c.placeholder && c.key !== 'hosting:webspace')) {
      comps.delete('hosting:unknown');
    }
  }

  // Manuelle Anpassungen im UI
  const hiddenComponents: Array<{ key: string; name: string }> = [];
  const hiddenLinks: Array<{ from: string; to: string; label: string }> = [];
  for (const r of db.all<{ key: string; kind: string; name: string; provider: string | null; description: string | null; details_json: string | null; hidden: number }>(
    'SELECT key, kind, name, provider, description, details_json, hidden FROM arch_components WHERE project_id = ?', projectId,
  )) {
    if (r.hidden) { hiddenComponents.push({ key: r.key, name: comps.get(r.key)?.name ?? r.name }); comps.delete(r.key); continue; }
    const existing = comps.get(r.key);
    comps.set(r.key, {
      key: r.key,
      kind: isArchKind(r.kind) ? r.kind : 'other',
      name: r.name,
      provider: r.provider,
      description: r.description,
      details: parse<ArchDetail[]>(r.details_json) ?? existing?.details ?? [],
      source: 'manual',
      ...(existing?.status ? { status: existing.status } : {}),
    });
  }
  for (const r of db.all<{ id: string; from_key: string; to_key: string; label: string; description: string | null; hidden: number }>(
    'SELECT id, from_key, to_key, label, description, hidden FROM arch_links WHERE project_id = ?', projectId,
  )) {
    const id = `${r.from_key}>${r.to_key}|${r.label}`;
    if (r.hidden) { hiddenLinks.push({ from: r.from_key, to: r.to_key, label: r.label }); links.delete(id); continue; }
    links.set(id, { id, from: r.from_key, to: r.to_key, label: r.label, description: r.description, source: 'manual' });
  }

  // Beziehungen zu fehlenden Komponenten verwerfen
  const finalLinks = [...links.values()].filter((l) => comps.has(l.from) && comps.has(l.to));
  return {
    components: [...comps.values()],
    links: finalLinks,
    facts_at: factsAt,
    manifest: { present: manifest !== null, error: manifestError },
    hidden: { components: hiddenComponents, links: hiddenLinks },
  };
}
