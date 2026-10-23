import { get, post, del } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, confirmModal, setModalError, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

export async function renderConnectors(el, project) {
  const [items, types, secrets] = await Promise.all([
    get(`/api/projects/${project.id}/connectors`),
    get('/api/connector-types'),
    get(`/api/projects/${project.id}/secrets?limit=500`).catch(() => []),
  ]);
  const canManage = roleAtLeast(project.role, 'maintainer');
  const labelOf = (t) => types.find((x) => x.type === t)?.label ?? t;

  const rows = items.map((c) => `
    <tr>
      <td><strong>${esc(c.name)}</strong><br><span class="muted text-sm">${esc(labelOf(c.type))} · ${esc(Object.values(c.config).join(' · '))}</span></td>
      <td>${c.last_check_at ? badge(c.last_check_ok ? 'ok' : 'Fehler', c.last_check_ok ? 'ok' : 'bad') : badge('ungeprüft', '')}
        ${c.last_check_message ? `<br><span class="muted text-sm">${esc(c.last_check_message)}</span>` : ''}</td>
      <td class="muted text-sm">${c.last_check_at ? fmtDate(c.last_check_at) : '–'}</td>
      <td class="actions">${canManage ? `
        <button class="btn subtle sm" data-check="${c.id}">Prüfen</button>
        <button class="btn ghost sm" data-delete="${c.id}" data-name="${esc(c.name)}">Entfernen</button>` : ''}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Integrationen</h2>
        ${canManage ? `<button class="btn sm" id="btn-new">${icon('plus')}Konnektor hinzufügen</button>` : ''}</div>
      <p class="muted text-sm">Zugangsdaten (z. B. ein GitHub-Token) liegen als Secret im Vault und werden nur serverseitig verwendet.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Konnektor</th><th>Status</th><th>Zuletzt geprüft</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4"><div class="empty-state">Keine Integrationen eingerichtet.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;

  const refresh = () => renderConnectors(el, project);
  $('#btn-new', el)?.addEventListener('click', async () => {
    const t = types[0];
    const res = await formModal({
      title: 'Konnektor hinzufügen', submitLabel: 'Anlegen',
      bodyHtml: `
        <label>Typ <select name="type">${types.map((x) => `<option value="${esc(x.type)}">${esc(x.label)}</option>`).join('')}</select></label>
        <label>Name <input name="name" required placeholder="z. B. GitHub Repo" /></label>
        ${t.fields.map((f) => `<label>${esc(f.label)} <input name="cfg_${esc(f.key)}" required placeholder="${esc(f.placeholder ?? '')}" /></label>`).join('')}
        <label>Credential (Secret im Vault)
          <select name="secret_id" required>${secrets.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.environment)})</option>`).join('')}</select>
        </label>
        ${secrets.length ? '' : '<p class="error">Zuerst ein Secret mit dem Token anlegen (Tab Secrets).</p>'}`,
    });
    if (!res) return;
    const config = {};
    for (const [k, v] of Object.entries(res.data)) if (k.startsWith('cfg_')) config[k.slice(4)] = v;
    try {
      await post(`/api/projects/${project.id}/connectors`, { type: res.data.type, name: res.data.name, secret_id: res.data.secret_id, config });
      closeModal(); toast('Konnektor angelegt', 'success'); refresh();
    } catch (err) { setModalError(res.root, err.message); }
  });
  for (const btn of $$('[data-check]', el)) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await post(`/api/projects/${project.id}/connectors/${btn.dataset.check}/check`);
        toast(r.message, r.ok ? 'success' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      refresh();
    });
  }
  for (const btn of $$('[data-delete]', el)) {
    btn.addEventListener('click', async () => {
      if (!await confirmModal({ title: 'Konnektor entfernen', message: `„${btn.dataset.name}“ entfernen? Das Secret bleibt erhalten.`, confirmLabel: 'Entfernen' })) return;
      try { await del(`/api/projects/${project.id}/connectors/${btn.dataset.delete}`); toast('Konnektor entfernt', 'success'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
}
