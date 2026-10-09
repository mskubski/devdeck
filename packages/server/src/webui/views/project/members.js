import { get, post, del } from '../../lib/api.js';
import { $, esc, badge, toast, formModal, setModalError, confirmModal, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

export async function renderMembers(el, project) {
  const members = await get(`/api/projects/${project.id}/members`);
  const canManage = roleAtLeast(project.role, 'maintainer');

  const rows = members.map((m) => `
    <tr>
      <td>${esc(m.display_name || m.email)}<br><span class="muted text-sm">${esc(m.email)}</span></td>
      <td>${badge(m.role, 'accent')}</td>
      <td class="actions">
        ${canManage ? `<button class="btn ghost sm" data-remove="${esc(m.user_id)}">Entfernen</button>` : ''}
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Mitglieder</h2>
        ${canManage ? '<button class="btn sm" id="btn-add-member">' + icon('plus') + 'Mitglied hinzufügen</button>' : ''}
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Benutzer</th><th>Rolle</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3"><div class="empty-state">Keine Mitglieder.</div></td></tr>'}</tbody></table>
      </div>
    </div>`;

  $('#btn-add-member', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Mitglied hinzufügen',
      submitLabel: 'Hinzufügen',
      bodyHtml: `
        <label>E-Mail <input name="email" type="email" required /></label>
        <label>Rolle
          <select name="role">
            <option value="viewer">viewer</option>
            <option value="developer" selected>developer</option>
            <option value="maintainer">maintainer</option>
            <option value="owner">owner</option>
          </select>
        </label>`,
    });
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/members`, res.data);
      closeModal();
      toast('Mitglied hinzugefügt', 'success');
      renderMembers(el, project);
    } catch (err) { setModalError(res.root, err.message); }
  });

  for (const btn of el.querySelectorAll('[data-remove]')) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Mitglied entfernen',
        message: 'Dieses Mitglied verliert den Zugriff auf das Projekt. Fortfahren?',
        confirmLabel: 'Entfernen',
      });
      if (!ok) return;
      try {
        await del(`/api/projects/${project.id}/members/${btn.dataset.remove}`);
        toast('Mitglied entfernt', 'success');
        renderMembers(el, project);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}
