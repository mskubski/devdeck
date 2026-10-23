import { randomUUID } from 'node:crypto';
import type { ChangelogItem, SecretItem, TaskItem } from '@devdeck/shared';
import type { AppContext } from '../context.js';
import { audit } from './audit.js';
import { createSecretRow, setSecretValue } from '../vault/secretOps.js';

export interface ImportSecret extends SecretItem {
  environment: string;
  source?: string;
}

export interface ImportInput {
  projectId: string;
  userId: string;
  actorLabel: string;
  machineId?: string | null;
  changelog: ChangelogItem[];
  tasks: TaskItem[];
  secrets: ImportSecret[];
  overwrite: boolean;
  dryRun: boolean;
}

export interface ImportSummary {
  dry_run: boolean;
  changelog: { total: number; new: number; existing: number };
  tasks: { total: number; new: number; new_done: number; existing: number };
  secrets: {
    total: number;
    new: number;
    existing: number;
    /** Nur Namen/Umgebung/Länge – niemals Werte. */
    items: Array<{ name: string; environment: string; action: 'new' | 'existing' | 'overwrite'; length: number }>;
  };
}

/**
 * Bestehende Projektdaten (aus CHANGELOG.md, ROADMAP/TODO.md, .env/credentials.md) übernehmen.
 * Idempotent: vorhandene Einträge (Changelog: Version+Titel, Tasks: Titel, Secrets: Name+Umgebung) werden übersprungen.
 */
export function importProjectData(ctx: AppContext, input: ImportInput): ImportSummary {
  const { db } = ctx;
  const pid = input.projectId;

  const knownLog = new Set(
    db.all<{ version: string | null; summary: string }>('SELECT version, summary FROM changelog_entries WHERE project_id = ?', pid)
      .map((e) => `${e.version ?? ''}|${e.summary}`),
  );
  const newLog = input.changelog.filter((c) => !knownLog.has(`${c.version ?? ''}|${c.summary}`));

  const knownTasks = new Set(db.all<{ title: string }>('SELECT title FROM tasks WHERE project_id = ?', pid).map((t) => t.title));
  const newTasks = input.tasks.filter((t) => !knownTasks.has(t.title));

  const existingSecrets = db.all<{ id: string; name: string; environment: string }>(
    'SELECT id, name, environment FROM secrets WHERE project_id = ?', pid,
  );
  const secretPlan = input.secrets.map((s) => {
    const hit = existingSecrets.find((e) => e.name === s.name && e.environment === s.environment);
    const action: 'new' | 'existing' | 'overwrite' = hit ? (input.overwrite ? 'overwrite' : 'existing') : 'new';
    return { s, hit, action };
  });

  const summary: ImportSummary = {
    dry_run: input.dryRun,
    changelog: { total: input.changelog.length, new: newLog.length, existing: input.changelog.length - newLog.length },
    tasks: {
      total: input.tasks.length,
      new: newTasks.length,
      new_done: newTasks.filter((t) => t.done).length,
      existing: input.tasks.length - newTasks.length,
    },
    secrets: {
      total: input.secrets.length,
      new: secretPlan.filter((p) => p.action === 'new').length,
      existing: secretPlan.filter((p) => p.action === 'existing').length,
      items: secretPlan.map((p) => ({ name: p.s.name, environment: p.s.environment, action: p.action, length: p.s.value.length })),
    },
  };
  if (input.dryRun) return summary;

  db.transaction(() => {
    const now = new Date().toISOString();
    // Älteste zuerst, damit die Reihenfolge in der Historie stimmt
    for (const c of [...newLog].reverse()) {
      const when = c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? `${c.date}T12:00:00.000Z` : now;
      db.run(
        `INSERT INTO changelog_entries (id, project_id, version, summary, body, source, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
        randomUUID(), pid, c.version, c.summary.slice(0, 300), c.body?.slice(0, 10_000) ?? null, input.userId,
        new Date(when) > new Date() ? now : when,
      );
    }
    for (const t of newTasks) {
      db.run(
        `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), pid, t.title.slice(0, 300), t.section ? `Abschnitt: ${t.section}` : null,
        t.done ? 'done' : 'open', Math.min(5, Math.max(1, t.priority)), input.userId, now, now, t.done ? now : null,
      );
    }
    for (const p of secretPlan) {
      if (p.action === 'existing') continue;
      const secretId = p.hit
        ? p.hit.id
        : createSecretRow(ctx, {
            projectId: pid, name: p.s.name, environment: p.s.environment, userId: input.userId,
            description: `Importiert aus ${p.s.source ?? 'Datei'}`,
          });
      setSecretValue(ctx, { projectId: pid, secretId, value: p.s.value });
      audit(db, {
        actor_type: 'user', actor_id: input.userId, actor_label: input.actorLabel,
        action: p.hit ? 'secret.value.set' : 'secret.create', project_id: pid, machine_id: input.machineId ?? null,
        target_type: 'secret', target_id: secretId, result: 'success',
        detail: { name: p.s.name, environment: p.s.environment, via: 'import' },
      });
    }
    audit(db, {
      actor_type: 'user', actor_id: input.userId, actor_label: input.actorLabel,
      action: 'project.import', project_id: pid, machine_id: input.machineId ?? null,
      target_type: 'project', target_id: pid, result: 'success',
      detail: {
        changelog: newLog.length, tasks: newTasks.length,
        secrets_created: secretPlan.filter((p) => p.action === 'new').length,
        secrets_updated: secretPlan.filter((p) => p.action === 'overwrite').length,
      },
    });
  });
  return summary;
}
