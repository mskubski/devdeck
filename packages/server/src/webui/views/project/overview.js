import { get } from '../../lib/api.js';
import { esc, fmtDate, badge } from '../../lib/ui.js';

export async function renderOverview(el, project) {
  const [tasks, sessions, workspaces, secrets] = await Promise.all([
    get(`/api/projects/${project.id}/tasks`).catch(() => []),
    get(`/api/projects/${project.id}/sessions`).catch(() => []),
    get(`/api/projects/${project.id}/workspaces`).catch(() => []),
    get(`/api/projects/${project.id}/secrets`).catch(() => []),
  ]);
  const openTasks = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length;
  const openSessions = sessions.filter((s) => s.status === 'open').length;

  el.innerHTML = `
    <div class="grid cols-3" style="margin-bottom:var(--space-5)">
      <div class="stat-tile"><span class="value">${openTasks}</span><span class="label">Offene Tasks</span></div>
      <div class="stat-tile"><span class="value">${openSessions}</span><span class="label">Laufende Sessions</span></div>
      <div class="stat-tile"><span class="value">${workspaces.length}</span><span class="label">Workspaces</span></div>
      <div class="stat-tile"><span class="value">${secrets.length}</span><span class="label">Secrets</span></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Projektinfo</h2>
        <div class="stack text-sm">
          <div><span class="muted">Slug</span><br><span class="mono">${esc(project.slug)}</span></div>
          <div><span class="muted">Repository</span><br>${esc(project.repo_remote || '–')}</div>
          <div><span class="muted">Standard-Branch</span><br><span class="mono">${esc(project.default_branch || 'main')}</span></div>
          <div><span class="muted">Angelegt</span><br>${fmtDate(project.created_at)}</div>
        </div>
      </div>
      <div class="card">
        <h2>Letzte Coding Sessions</h2>
        ${sessions.length === 0 ? '<div class="empty-state">Noch keine Sessions.</div>' : `
        <div class="stack">
          ${sessions.slice(0, 5).map((s) => `
            <div class="row between">
              <span class="text-sm">${esc(s.goal || '(ohne Ziel)')}</span>
              ${badge(s.status === 'open' ? 'läuft' : 'beendet', s.status === 'open' ? 'warn' : 'ok')}
            </div>`).join('')}
        </div>`}
      </div>
    </div>`;
}
