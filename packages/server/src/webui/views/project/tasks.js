import { get, post, patch, del } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, setModalError, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

const STATUS_LABEL = { open: 'offen', in_progress: 'in Arbeit', done: 'erledigt', cancelled: 'verworfen' };

export async function renderTasks(el, project) {
  const tasks = await get(`/api/projects/${project.id}/tasks`);
  const canManage = roleAtLeast(project.role, 'maintainer');

  const rows = tasks.map((t) => `
    <tr>
      <td>
        <strong>${esc(t.title)}</strong>
        ${t.description ? `<br><span class="muted text-sm">${esc(t.description)}</span>` : ''}
      </td>
      <td>${badge(STATUS_LABEL[t.status] ?? t.status, t.status)}</td>
      <td>P${esc(t.priority)}</td>
      <td class="muted text-sm">${esc(t.created_by_email || '–')}</td>
      <td class="muted text-sm">${fmtDate(t.created_at)}</td>
      <td class="actions">
        ${canManage && t.status === 'open' ? `<button class="btn ghost sm" data-start="${t.id}">Starten</button>` : ''}
        ${canManage && (t.status === 'open' || t.status === 'in_progress') ? `
          <button class="btn subtle sm" data-complete="${t.id}">Erledigt</button>
          <button class="btn ghost sm" data-cancel="${t.id}">Verwerfen</button>` : ''}
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Tasks</h2>
        ${canManage ? '<button class="btn sm" id="btn-new-task">' + icon('plus') + 'Neuer Task</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Titel</th><th>Status</th><th>Priorität</th><th>Erstellt von</th><th>Erstellt</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty-state"><div class="icon">' + icon('tasks', { size: 32 }) + '</div>Keine Tasks vorhanden.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-task', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Neuer Task',
      submitLabel: 'Anlegen',
      bodyHtml: `
        <label>Titel <input name="title" required /></label>
        <label>Beschreibung <textarea name="description" rows="3"></textarea></label>
        <label>Priorität (1–5)
          <select name="priority">
            <option value="1">1 – niedrig</option>
            <option value="2">2</option>
            <option value="3" selected>3 – normal</option>
            <option value="4">4</option>
            <option value="5">5 – hoch</option>
          </select>
        </label>`,
    });
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/tasks`, { ...res.data, priority: Number(res.data.priority) });
      closeModal();
      toast('Task angelegt', 'success');
      renderTasks(el, project);
    } catch (err) { setModalError(res.root, err.message); }
  });

  const refresh = () => renderTasks(el, project);
  for (const btn of $$('[data-start]', el)) {
    btn.addEventListener('click', async () => {
      try { await patch(`/api/projects/${project.id}/tasks/${btn.dataset.start}`, { status: 'in_progress' }); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
  for (const btn of $$('[data-complete]', el)) {
    btn.addEventListener('click', async () => {
      try { await post(`/api/projects/${project.id}/tasks/${btn.dataset.complete}/complete`); toast('Task erledigt', 'success'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
  for (const btn of $$('[data-cancel]', el)) {
    btn.addEventListener('click', async () => {
      try { await del(`/api/projects/${project.id}/tasks/${btn.dataset.cancel}`); toast('Task verworfen', 'success'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
}
