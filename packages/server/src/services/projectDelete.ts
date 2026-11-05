import { AppError } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { slugify } from '../auth/tokens.js';
import { audit } from './audit.js';
import { clearStaging } from './backupReplicas.js';

/**
 * Projekt löschen – zwei Stufen:
 *  – „Nur Projekt“ (soft): Das Projekt verschwindet aus allen Listen und ruht (keine Backups, Syncs, Prüfungen), seine Daten in DevDeck bleiben erhalten;
 *    ein Admin kann es wiederherstellen. Name und Slug werden freigegeben, damit sich ein neues Projekt so nennen darf.
 *  – „Mit Daten“ (purge): Das Projekt und alles, was in DevDeck daran hängt, wird endgültig gelöscht (inkl. Secret-Werte im Vault).
 * Dateien auf den Maschinen (Workspace-Ordner, Backup-Ordner und Repliken) werden in keinem Fall angefasst.
 */

interface Actor {
  id: string | null;
  label: string;
  ip?: string | null;
}

export interface DeletedProject {
  id: string;
  name: string;
  slug: string;
  deleted_name: string;
  deleted_slug: string;
  deleted_at: string;
  deleted_by_email: string | null;
}

/** Was an einem Projekt hängt (für die Rückfrage vor dem Löschen). */
export function deletePreview(ctx: AppContext, projectId: string): Record<string, number> {
  const count = (sql: string): number => {
    try {
      return ctx.db.get<{ n: number }>(sql, projectId)?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    members: count('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?'),
    workspaces: count('SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ?'),
    tasks: count('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?'),
    decisions: count('SELECT COUNT(*) AS n FROM decisions WHERE project_id = ?'),
    changelog: count('SELECT COUNT(*) AS n FROM changelog_entries WHERE project_id = ?'),
    sessions: count('SELECT COUNT(*) AS n FROM coding_sessions WHERE project_id = ?'),
    secrets: count('SELECT COUNT(*) AS n FROM secrets WHERE project_id = ?'),
    connectors: count('SELECT COUNT(*) AS n FROM project_connectors WHERE project_id = ?'),
    backup_jobs: count('SELECT COUNT(*) AS n FROM backup_jobs WHERE project_id = ?'),
    backups: count(`SELECT COUNT(*) AS n FROM project_backups WHERE project_id = ? AND status = 'success'`),
  };
}

const shortId = (id: string): string => id.replace(/-/g, '').slice(0, 6);

/** Nur das Projekt löschen: ausblenden und ruhen lassen, Daten bleiben (wiederherstellbar). */
export function softDeleteProject(ctx: AppContext, project: { id: string; name: string; slug: string }, actor: Actor): void {
  const now = new Date().toISOString();
  ctx.db.run(
    `UPDATE projects SET deleted_at = ?, deleted_by = ?, deleted_name = name, deleted_slug = slug,
       name = name || ' (gelöscht ' || ? || ')', slug = slug || '-geloescht-' || ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    now, actor.id, shortId(project.id), shortId(project.id), now, project.id,
  );
  audit(ctx.db, {
    actor_type: 'user', actor_id: actor.id, actor_label: actor.label, action: 'project.delete', project_id: project.id,
    target_type: 'project', target_id: project.id, result: 'success', detail: { name: project.name, mode: 'keep_data' }, ip: actor.ip ?? undefined,
  });
}

/** Gelöschtes Projekt wiederherstellen (Admin). Ist der Name inzwischen vergeben, bekommt es den Zusatz „(wiederhergestellt)“. */
export function restoreProject(ctx: AppContext, projectId: string, actor: Actor): { id: string; name: string; slug: string } {
  const p = ctx.db.get<{ id: string; deleted_name: string | null; deleted_slug: string | null; deleted_at: string | null }>(
    'SELECT id, deleted_name, deleted_slug, deleted_at FROM projects WHERE id = ?', projectId,
  );
  if (!p || !p.deleted_at) throw new AppError('NOT_FOUND', 'Gelöschtes Projekt nicht gefunden');
  const taken = (name: string, slug: string): boolean => Boolean(ctx.db.get('SELECT 1 AS x FROM projects WHERE (name = ? OR slug = ?) AND id <> ?', name, slug, p.id));
  let name = p.deleted_name ?? 'Projekt';
  let slug = p.deleted_slug ?? slugify(name);
  for (let i = 0; taken(name, slug); i += 1) {
    name = `${p.deleted_name ?? 'Projekt'} (wiederhergestellt${i ? ` ${i + 1}` : ''})`;
    slug = `${p.deleted_slug ?? slugify(name)}-wiederhergestellt${i ? `-${i + 1}` : ''}`;
  }
  ctx.db.run(
    `UPDATE projects SET name = ?, slug = ?, deleted_at = NULL, deleted_by = NULL, deleted_name = NULL, deleted_slug = NULL, updated_at = ? WHERE id = ?`,
    name, slug, new Date().toISOString(), p.id,
  );
  audit(ctx.db, {
    actor_type: 'user', actor_id: actor.id, actor_label: actor.label, action: 'project.restore', project_id: p.id,
    target_type: 'project', target_id: p.id, result: 'success', detail: { name }, ip: actor.ip ?? undefined,
  });
  return { id: p.id, name, slug };
}

/**
 * Projekt mit allen Daten endgültig löschen: Datenbank-Einträge (Tasks, Entscheidungen, Changelog, Sessions, Workspaces, Secrets, Backup-Jobs und -Einträge,
 * Konnektoren, Mitglieder, …) und die Secret-Werte im Vault. Dateien auf den Maschinen bleiben unangetastet. Der Audit-Eintrag bleibt bestehen.
 */
export function purgeProject(ctx: AppContext, project: { id: string; name: string }, actor: Actor): Record<string, number> {
  const counts = deletePreview(ctx, project.id);
  const refs = ctx.db.all<{ vault_reference: string }>('SELECT vault_reference FROM secrets WHERE project_id = ?', project.id);
  const replicas = ctx.db.all<{ id: string }>(
    'SELECT r.id FROM backup_replicas r JOIN backup_jobs j ON j.id = r.job_id WHERE j.project_id = ?', project.id,
  );
  ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM projects WHERE id = ?', project.id); // Fremdschlüssel löschen alles Abhängige mit
  });
  for (const r of replicas) clearStaging(ctx, r.id);
  for (const ref of refs) {
    try {
      ctx.vault?.delete(ref.vault_reference);
    } catch {
      /* Wert war schon weg – das Projekt ist trotzdem gelöscht */
    }
  }
  audit(ctx.db, {
    actor_type: 'user', actor_id: actor.id, actor_label: actor.label, action: 'project.purge', project_id: project.id,
    target_type: 'project', target_id: project.id, result: 'success', detail: { name: project.name, counts }, ip: actor.ip ?? undefined,
  });
  return counts;
}

export function listDeleted(ctx: AppContext): DeletedProject[] {
  return ctx.db.all<DeletedProject>(
    `SELECT p.id, p.name, p.slug, p.deleted_name, p.deleted_slug, p.deleted_at, u.email AS deleted_by_email
     FROM projects p LEFT JOIN users u ON u.id = p.deleted_by WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`,
  );
}
