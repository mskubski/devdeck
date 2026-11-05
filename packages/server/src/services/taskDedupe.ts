import { taskKey } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { audit } from './audit.js';

/**
 * Doppelte Tasks eines Projekts finden und bereinigen. Gleich sind Tasks, deren Titel sich nur durch führende Symbole/Emoji, Groß-/Kleinschreibung
 * oder Leerraum unterscheiden (siehe `taskKey`) – so werden auch Tasks erkannt, deren Emoji durch den früheren Import-Fehler beschädigt wurde.
 * Behalten wird je Gruppe der Task mit dem weitesten Stand (in Arbeit > erledigt > offen), bei Gleichstand der älteste. Verworfene Tasks bleiben unangetastet.
 */

interface Row {
  id: string;
  title: string;
  status: string;
  created_at: string;
  linked: number;
}

export interface DedupeGroup {
  keep: { id: string; title: string; status: string };
  /** Titel, der übernommen wird, wenn der behaltene beschädigt ist (U+FFFD) und ein Duplikat einen heilen hat */
  repair_title: string | null;
  remove: Array<{ id: string; title: string; status: string; created_at: string; linked: boolean }>;
}

const RANK: Record<string, number> = { in_progress: 3, done: 2, open: 1, cancelled: 0 };

export function planTaskDedupe(ctx: AppContext, projectId: string): DedupeGroup[] {
  const rows = ctx.db.all<Row>(
    `SELECT t.id, t.title, t.status, t.created_at,
            EXISTS (SELECT 1 FROM issue_links l WHERE l.kind = 'task' AND l.local_id = t.id) AS linked
     FROM tasks t WHERE t.project_id = ? ORDER BY t.created_at, t.rowid`,
    projectId,
  );
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.status === 'cancelled') continue; // verworfene Tasks sind erledigt abgelegt und bleiben unangetastet
    const k = taskKey(r.title);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: DedupeGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = [...list].sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || a.created_at.localeCompare(b.created_at))[0]!;
    const clean = list.find((r) => !r.title.includes('�'));
    out.push({
      keep: { id: keep.id, title: keep.title, status: keep.status },
      repair_title: keep.title.includes('�') && clean ? clean.title : null,
      remove: list.filter((r) => r.id !== keep.id).map((r) => ({ id: r.id, title: r.title, status: r.status, created_at: r.created_at, linked: r.linked === 1 })),
    });
  }
  return out;
}

export function applyTaskDedupe(ctx: AppContext, projectId: string, actor: { id: string; label: string }): { groups: number; deleted: number; cancelled: number; repaired: number } {
  const groups = planTaskDedupe(ctx, projectId);
  const now = new Date().toISOString();
  let deleted = 0;
  let cancelled = 0;
  let repaired = 0;
  ctx.db.transaction(() => {
    for (const g of groups) {
      if (g.repair_title) {
        ctx.db.run('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?', g.repair_title, now, g.keep.id);
        repaired += 1;
      }
      for (const r of g.remove) {
        // Mit GitHub-Issue verknüpfte Duplikate werden verworfen (der Abgleich schließt das Issue), alle anderen gelöscht
        if (r.linked) {
          ctx.db.run(`UPDATE tasks SET status = 'cancelled', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?`, now, now, r.id);
          cancelled += 1;
        } else {
          ctx.db.run('DELETE FROM tasks WHERE id = ?', r.id);
          deleted += 1;
        }
      }
    }
  });
  audit(ctx.db, {
    actor_type: 'user', actor_id: actor.id, actor_label: actor.label, action: 'task.dedupe', project_id: projectId,
    target_type: 'project', target_id: projectId, result: 'success', detail: { groups: groups.length, deleted, cancelled, repaired },
  });
  return { groups: groups.length, deleted, cancelled, repaired };
}
