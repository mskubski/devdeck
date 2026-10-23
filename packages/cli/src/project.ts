import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceDto } from '@devdeck/shared';
import { api, CliError } from './client.js';
import type { CliConfig } from './config.js';

export interface Membership {
  project_id: string;
  role: string;
  name: string;
  slug: string;
}

export interface ResolvedProject {
  projectId: string;
  projectName: string;
  /** Workspace-Wurzel (Ordner mit .devdeck/ bzw. registriertem local_path) oder cwd. */
  root: string;
  workspaceId: string | null;
}

interface ProjectFile {
  project_id: string;
  workspace_id?: string | null;
}

/** Vom Workspace-Ordner aufwärts nach `.devdeck/` suchen. */
export function findDevdeckRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.devdeck'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readProjectFile(root: string): ProjectFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.devdeck', 'project.json'), 'utf8')) as ProjectFile;
  } catch {
    return null;
  }
}

export function writeProjectFile(root: string, data: ProjectFile): void {
  const dir = path.join(root, '.devdeck');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(data, null, 2)}\n`);
}

export async function memberships(config: CliConfig): Promise<Membership[]> {
  const me = await api<{ memberships: Membership[] }>(config, 'GET', '/api/auth/me');
  return me.memberships;
}

/**
 * Projekt ermitteln: --project/DEVDECK_PROJECT → `.devdeck/project.json` → registrierter
 * Workspace-Pfad (cwd oder übergeordneter Ordner). Ergebnis wird in project.json gemerkt.
 */
export async function resolveProject(
  config: CliConfig,
  cwd: string,
  opts: { project?: string; env: NodeJS.ProcessEnv },
): Promise<ResolvedProject> {
  const list = await memberships(config);
  const wanted = opts.project ?? opts.env.DEVDECK_PROJECT;
  const root = findDevdeckRoot(cwd);

  if (wanted) {
    const m = list.find((p) => p.slug === wanted || p.project_id === wanted || p.name === wanted);
    if (!m) throw new CliError(`Projekt nicht gefunden oder kein Zugriff: ${wanted}`, 'NOT_FOUND');
    return { projectId: m.project_id, projectName: m.name, root: root ?? cwd, workspaceId: null };
  }

  if (root) {
    const file = readProjectFile(root);
    const m = file && list.find((p) => p.project_id === file.project_id);
    if (file && m) {
      return { projectId: m.project_id, projectName: m.name, root, workspaceId: file.workspace_id ?? null };
    }
  }

  const resolvedCwd = path.resolve(cwd);
  for (const m of list) {
    const workspaces = await api<WorkspaceDto[]>(config, 'GET', `/api/projects/${m.project_id}/workspaces`);
    const hit = workspaces
      .filter((w) => resolvedCwd === w.local_path || resolvedCwd.startsWith(w.local_path + path.sep))
      .sort((a, b) => b.local_path.length - a.local_path.length)[0];
    if (hit) {
      if (fs.existsSync(path.join(hit.local_path, '.devdeck'))) {
        writeProjectFile(hit.local_path, { project_id: m.project_id, workspace_id: hit.id });
      }
      return { projectId: m.project_id, projectName: m.name, root: hit.local_path, workspaceId: hit.id };
    }
  }
  throw new CliError(
    'Projekt nicht erkennbar. Im Workspace-Ordner ausführen oder --project <slug> angeben.',
    'NOT_FOUND',
  );
}
