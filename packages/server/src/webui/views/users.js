import { get, post, patch } from '../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, setModalError, confirmModal, closeModal } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

export async function renderUsers(el) {
  const users = await get('/api/users');

  const rows = users.map((u) => `
    <tr>
      <td>${esc(u.display_name || u.email)}<br><span class="muted text-sm">${esc(u.email)}</span></td>
      <td>${badge(u.system_role, u.system_role === 'admin' ? 'accent' : '')}</td>
      <td>${u.disabled ? badge('gesperrt', 'bad') : badge('aktiv', 'ok')}</td>
      <td class="muted text-sm">${fmtDate(u.created_at)}</td>
      <td class="actions">
        <button class="btn ghost sm" data-reset="${u.id}">Passwort setzen</button>
        <button class="btn ghost sm" data-toggle="${u.id}" data-disabled="${u.disabled}">${u.disabled ? 'Entsperren' : 'Sperren'}</button>
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Benutzerverwaltung</h1>
        <p class="lede">Systemweite Benutzer und Rollen (admin/developer). Projektrollen werden je Projekt unter „Mitglieder“ vergeben.</p>
      </div>
      <div class="page-actions"><button class="btn" id="btn-new-user">${icon('plus')}Benutzer anlegen</button></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Benutzer</th><th>Systemrolle</th><th>Status</th><th>Erstellt</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-user', el).addEventListener('click', async () => {
    const res = await formModal({
      title: 'Benutzer anlegen',
      submitLabel: 'Anlegen',
      bodyHtml: `
        <label>E-Mail <input name="email" type="email" required /></label>
        <label>Name <input name="display_name" /></label>
        <label>Initiales Passwort <input name="password" type="password" required minlength="8" /></label>
        <label>Systemrolle
          <select name="system_role"><option value="developer" selected>developer</option><option value="admin">admin</option></select>
        </label>`,
    });
    if (!res) return;
    try {
      await post('/api/users', res.data);
      closeModal();
      toast('Benutzer angelegt', 'success');
      renderUsers(el);
    } catch (err) { setModalError(res.root, err.message); }
  });

  for (const btn of $$('[data-reset]', el)) {
    btn.addEventListener('click', async () => {
      const res = await formModal({
        title: 'Neues Passwort setzen',
        submitLabel: 'Setzen',
        bodyHtml: '<label>Neues Passwort <input name="password" type="password" required minlength="8" /></label>',
      });
      if (!res) return;
      try {
        await patch(`/api/users/${btn.dataset.reset}`, res.data);
        closeModal();
        toast('Passwort gesetzt – alle Sessions des Benutzers wurden beendet', 'success');
      } catch (err) { setModalError(res.root, err.message); }
    });
  }

  for (const btn of $$('[data-toggle]', el)) {
    btn.addEventListener('click', async () => {
      const willDisable = btn.dataset.disabled !== 'true';
      if (willDisable) {
        const ok = await confirmModal({
          title: 'Benutzer sperren',
          message: 'Der Benutzer wird abgemeldet und kann sich nicht mehr anmelden. Fortfahren?',
          confirmLabel: 'Sperren',
        });
        if (!ok) return;
      }
      try {
        await patch(`/api/users/${btn.dataset.toggle}`, { disabled: willDisable });
        toast(willDisable ? 'Benutzer gesperrt' : 'Benutzer entsperrt', 'success');
        renderUsers(el);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}
