import { get, post } from '../lib/api.js';
import { $, esc, fmtDate, toast } from '../lib/ui.js';
import { state } from '../lib/api.js';
import { icon } from '../lib/icons.js';

export async function renderProjects(el) {
  const projects = await get('/api/projects');
  const rows = projects.map((p) => `
    <tr>
      <td><a class="link" href="#/projects/${esc(p.id)}">${esc(p.name)}</a></td>
      <td><span class="badge accent">${esc(p.role || 'member')}</span></td>
      <td class="muted">${esc(p.description || '–')}</td>
      <td class="muted mono text-sm">${esc(p.repo_remote || '–')}</td>
      <td class="muted text-sm">${fmtDate(p.created_at)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Projekte</h1>
        <p class="lede">Zentrale Projektübersicht – Tasks, Sessions, Secrets und Workspaces findest du im jeweiligen Projekt.</p>
      </div>
      ${state.user.system_role === 'admin' ? '<div class="page-actions"><button class="btn" id="btn-new-project">' + icon('plus') + 'Neues Projekt</button></div>' : ''}
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Rolle</th><th>Beschreibung</th><th>Repository</th><th>Erstellt</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5"><div class="empty-state"><div class="icon">' + icon('folder', { size: 32 }) + '</div>Noch keine Projekte.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>
    ${state.user.system_role === 'admin' ? `
    <div class="card" id="new-project-card">
      <div class="card-head"><h2>Projekt anlegen</h2></div>
      <form id="newproject">
        <div class="field-row">
          <label>Name <input name="name" required /></label>
          <label>Git-Remote <input name="repo_remote" placeholder="https://github.com/..." /></label>
        </div>
        <label>Beschreibung
          <textarea name="description" rows="2" maxlength="4000"></textarea>
          <span class="muted text-sm">Maximal 4000 Zeichen.</span>
        </label>
        <button class="btn" type="submit">Anlegen</button>
        <p class="error" id="nperr"></p>
      </form>
    </div>` : ''}`;

  const form = $('#newproject', el);
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        const project = await post('/api/projects', Object.fromEntries(fd));
        toast(`Projekt „${project.name}“ angelegt`, 'success');
        location.hash = `#/projects/${project.id}`;
      } catch (err) { $('#nperr', el).textContent = err.message; }
    });
  }
}
