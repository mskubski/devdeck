import { get, post, del } from '../../lib/api.js';
import { $, $$, esc, badge, toast, formModal, setModalError, confirmModal, openModal, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

const ENV_ORDER = ['development', 'staging', 'production'];

export async function renderSecrets(el, project) {
  const secrets = await get(`/api/projects/${project.id}/secrets`);
  const canManage = roleAtLeast(project.role, 'maintainer');

  const rows = secrets
    .slice()
    .sort((a, b) => ENV_ORDER.indexOf(a.environment) - ENV_ORDER.indexOf(b.environment) || a.name.localeCompare(b.name))
    .map((s) => `
    <tr>
      <td><span class="mono">${esc(s.name)}</span>${s.description ? `<br><span class="muted text-sm">${esc(s.description)}</span>` : ''}</td>
      <td>${badge(s.environment, s.environment === 'production' ? 'bad' : s.environment === 'staging' ? 'warn' : 'ok')}</td>
      <td class="muted text-sm">${esc(s.kind)}</td>
      <td>${s.has_value ? badge('gesetzt (v' + s.version + ')', 'ok') : badge('kein Wert', 'warn')}</td>
      <td class="actions">
        <button class="btn ghost sm" data-set="${s.id}">Wert setzen</button>
        ${s.has_value ? `<button class="btn ghost sm" data-reveal="${s.id}" data-name="${esc(s.name)}">Anzeigen</button>` : ''}
        ${canManage ? `<button class="btn ghost sm" data-delete="${s.id}" data-name="${esc(s.name)}">Löschen</button>` : ''}
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="alert info">${icon('lock')}<span>Werte werden AES-256-GCM-verschlüsselt im DevDeck Vault gespeichert und nur mit <span class="mono">secret.reveal</span>-Berechtigung angezeigt. Jede Anzeige wird im Audit-Log protokolliert.</span></div>
    <div class="card">
      <div class="card-head">
        <h2>Secrets</h2>
        ${canManage ? '<button class="btn sm" id="btn-new-secret">' + icon('plus') + 'Neues Secret</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Environment</th><th>Typ</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5"><div class="empty-state"><div class="icon">' + icon('key', { size: 32 }) + '</div>Keine Secrets hinterlegt.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-secret', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Neues Secret',
      submitLabel: 'Anlegen',
      bodyHtml: `
        <label>Name <input name="name" required placeholder="SUPABASE_SERVICE_ROLE_KEY" /></label>
        <label>Beschreibung <input name="description" /></label>
        <div class="field-row">
          <label>Typ
            <select name="kind"><option value="env">env (.env-Variable)</option><option value="file">file (Secret File)</option></select>
          </label>
          <label>Environment
            <select name="environment">
              <option value="development">development</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </select>
          </label>
        </div>`,
    });
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/secrets`, res.data);
      closeModal();
      toast('Secret angelegt', 'success');
      renderSecrets(el, project);
    } catch (err) { setModalError(res.root, err.message); }
  });

  for (const btn of $$('[data-set]', el)) {
    btn.addEventListener('click', async () => {
      const res = await formModal({
        title: 'Wert setzen',
        submitLabel: 'Speichern',
        bodyHtml: `<label>Wert <textarea name="value" rows="3" required></textarea></label>
          <p class="muted text-sm">Der Wert wird sofort verschlüsselt gespeichert und ist danach nicht mehr im Klartext in diesem Formular sichtbar.</p>`,
      });
      if (!res) return;
      try {
        await post(`/api/projects/${project.id}/secrets/${btn.dataset.set}/values`, res.data);
        closeModal();
        toast('Wert gespeichert', 'success');
        renderSecrets(el, project);
      } catch (err) { setModalError(res.root, err.message); }
    });
  }

  for (const btn of $$('[data-reveal]', el)) {
    btn.addEventListener('click', async () => {
      try {
        const result = await get(`/api/projects/${project.id}/secrets/${btn.dataset.reveal}/values`);
        if (!result.has_value) { toast('Kein Wert gespeichert', 'error'); return; }
        openRevealModal(btn.dataset.name, result.value);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  for (const btn of $$('[data-delete]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Secret löschen',
        message: `„${btn.dataset.name}“ inklusive gespeichertem Wert endgültig löschen?`,
        confirmLabel: 'Löschen',
      });
      if (!ok) return;
      try {
        await del(`/api/projects/${project.id}/secrets/${btn.dataset.delete}`);
        toast('Secret gelöscht', 'success');
        renderSecrets(el, project);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

function openRevealModal(name, value) {
  openModal(`
    <h2>${esc(name)}</h2>
    <div class="secret-value">${esc(value)}</div>
    <div class="modal-actions">
      <button class="btn" id="btn-copy" type="button">In Zwischenablage kopieren</button>
    </div>`, (root) => {
    root.querySelector('#btn-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); toast('Kopiert', 'success'); }
      catch { toast('Kopieren nicht möglich', 'error'); }
    });
  });
}
