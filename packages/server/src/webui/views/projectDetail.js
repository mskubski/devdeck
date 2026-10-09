import { get, patch } from '../lib/api.js';
import { $, esc, badge, formModal, setModalError, toast, closeModal } from '../lib/ui.js';
import { roleAtLeast } from '../lib/roles.js';
import { icon } from '../lib/icons.js';
import { renderOverview } from './project/overview.js';
import { renderMembers } from './project/members.js';
import { renderTasks } from './project/tasks.js';
import { renderSessions } from './project/sessions.js';
import { renderSecrets } from './project/secrets.js';
import { renderWorkspaces } from './project/workspaces.js';

const TABS = [
  { key: 'overview', icon: 'dashboard', label: 'Übersicht', render: renderOverview },
  { key: 'members', icon: 'users', label: 'Mitglieder', render: renderMembers },
  { key: 'tasks', icon: 'tasks', label: 'Tasks', render: renderTasks },
  { key: 'sessions', icon: 'code', label: 'Sessions', render: renderSessions },
  { key: 'secrets', icon: 'key', label: 'Secrets', render: renderSecrets },
  { key: 'workspaces', icon: 'laptop', label: 'Workspaces', render: renderWorkspaces },
];

export async function renderProjectDetail(el, idAndQuery, setBreadcrumb) {
  const [id, qs] = idAndQuery.split('?');
  const activeTab = new URLSearchParams(qs ?? '').get('tab') || 'overview';
  const project = await get(`/api/projects/${id}`);
  setBreadcrumb?.(project.name, 'Projekte');
  const canEdit = roleAtLeast(project.role, 'maintainer');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(project.name)} ${badge(project.role || 'member', 'accent')}</h1>
        <p class="lede">${esc(project.description || 'Keine Beschreibung hinterlegt.')}</p>
      </div>
      ${canEdit ? '<div class="page-actions"><button class="btn ghost sm" id="btn-edit-project">Bearbeiten</button></div>' : ''}
    </div>
    <div class="tabs" id="project-tabs">
      ${TABS.map((t) => `<button class="tab ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}">${icon(t.icon, { size: 16 })}${t.label}</button>`).join('')}
    </div>
    <div id="tab-body"></div>`;

  const body = $('#tab-body', el);
  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  await active.render(body, project);

  for (const btn of el.querySelectorAll('[data-tab]')) {
    btn.addEventListener('click', () => {
      location.hash = `#/projects/${id}?tab=${btn.dataset.tab}`;
    });
  }

  $('#btn-edit-project', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Projekt bearbeiten',
      submitLabel: 'Speichern',
      bodyHtml: `
        <label>Name <input name="name" value="${esc(project.name)}" maxlength="200" required /></label>
        <label>Beschreibung
          <textarea name="description" rows="4" maxlength="4000">${esc(project.description || '')}</textarea>
          <span class="muted text-sm">Maximal 4000 Zeichen.</span>
        </label>
        <label>Git-Remote <input name="repo_remote" value="${esc(project.repo_remote || '')}" maxlength="500" placeholder="https://github.com/..." /></label>
        <label>Standard-Branch <input name="default_branch" value="${esc(project.default_branch || 'main')}" maxlength="100" /></label>`,
    });
    if (!res) return;
    try {
      await patch(`/api/projects/${id}`, res.data);
      closeModal();
      toast('Projekt aktualisiert', 'success');
      renderProjectDetail(el, idAndQuery, setBreadcrumb);
    } catch (err) {
      setModalError(res.root, err.message);
    }
  });
}
