import { get, post, del } from '../lib/api.js';
import { $, $$, esc, fmtDate, toast, confirmModal, openModal, closeModal, setModalError } from '../lib/ui.js';
import { state } from '../lib/api.js';
import { icon } from '../lib/icons.js';

const MON_LABEL = { ok: 'OK', warn: 'Warnung', error: 'Ausfall', unknown: 'unbekannt' };
const MON_CLASS = { ok: 'ok', warn: 'warn', error: 'bad', unknown: 'unknown' };

/** Ampel-Spalte: grün/gelb/rot mit Anzahl, Link zum Monitoring des Projekts. */
function monitoringCell(p) {
  const m = p.monitoring;
  if (!m || m.status === 'none') return `<a class="link muted text-sm" href="#/monitoring?project=${esc(p.id)}" title="Noch keine Monitore – im Monitoring anlegen">–</a>`;
  const detail = m.status === 'error' ? `${m.error} Ausfall${m.error === 1 ? '' : 'e'}${m.warn ? `, ${m.warn} Warnung${m.warn === 1 ? '' : 'en'}` : ''}`
    : m.status === 'warn' ? `${m.warn} Warnung${m.warn === 1 ? '' : 'en'}`
    : m.status === 'ok' ? `${m.ok} von ${m.total} OK` : 'noch keine Messung';
  return `<a class="mon-cell ${MON_CLASS[m.status]}" href="#/monitoring?project=${esc(p.id)}" title="${esc(`${MON_LABEL[m.status]} – ${detail} · zum Monitoring`)}">
    <span class="mon-dot ${MON_CLASS[m.status]}" aria-hidden="true"></span><span>${esc(MON_LABEL[m.status])}</span><span class="muted text-sm">${esc(detail)}</span></a>`;
}

export async function renderProjects(el) {
  const projects = await get('/api/projects');
  const isAdmin = state.user.system_role === 'admin';
  const deleted = isAdmin ? await get('/api/projects?deleted=1').catch(() => []) : [];
  const rows = projects.map((p) => `
    <tr>
      <td><a class="link" href="#/projects/${esc(p.id)}">${esc(p.name)}</a></td>
      <td><span class="badge accent">${esc(p.role || 'member')}</span></td>
      <td class="muted">${esc(p.description || '–')}</td>
      <td class="muted mono text-sm">${esc(p.repo_remote || '–')}</td>
      <td class="muted text-sm">${fmtDate(p.created_at)}</td>
      <td>${monitoringCell(p)}</td>
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
          <thead><tr><th>Name</th><th>Rolle</th><th>Beschreibung</th><th>Repository</th><th>Erstellt</th><th>Monitoring</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty-state"><div class="icon">' + icon('folder', { size: 32 }) + '</div>Noch keine Projekte.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>
    ${deleted.length ? `
    <div class="card" id="deleted-projects">
      <div class="card-head"><h2>Gelöschte Projekte</h2><span class="muted text-sm">${deleted.length}</span></div>
      <p class="muted text-sm">Diese Projekte sind ausgeblendet und ruhen; ihre Daten in DevDeck sind noch vorhanden. Wiederherstellen bringt alles zurück, „Endgültig löschen“ entfernt die Daten unwiderruflich (nur nach Eingabe des Projektnamens).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Gelöscht</th><th>Von</th><th></th></tr></thead>
        <tbody>${deleted.map((p) => `<tr>
          <td>${esc(p.deleted_name || p.name)}</td>
          <td class="muted text-sm">${fmtDate(p.deleted_at)}</td>
          <td class="muted text-sm">${esc(p.deleted_by_email || '–')}</td>
          <td class="actions">
            <button class="btn ghost sm" data-restore="${esc(p.id)}">${icon('history', { size: 14 })}Wiederherstellen</button>
            <button class="btn ghost sm danger" data-purge="${esc(p.id)}" data-name="${esc(p.deleted_name || p.name)}">${icon('trash', { size: 14 })}Endgültig löschen</button>
          </td></tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
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

  $$('[data-restore]', el).forEach((b) => b.addEventListener('click', async () => {
    try {
      const p = await post(`/api/projects/${b.dataset.restore}/restore`);
      toast(`Projekt „${p.name}“ wiederhergestellt`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderProjects(el);
  }));
  $$('[data-purge]', el).forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.name;
    openModal(`
      <h2>${icon('trash', { size: 20 })} „${esc(name)}“ endgültig löschen</h2>
      <div class="alert danger"><span>Alle Daten dieses Projekts in DevDeck (Tasks, Entscheidungen, Changelog, Sessions, Secrets inkl. Vault-Werte, Backup-Einträge) werden unwiderruflich gelöscht. Dateien auf den Maschinen bleiben unberührt.</span></div>
      <label>Zur Bestätigung den Projektnamen <strong class="mono">${esc(name)}</strong> eintippen <input id="purge-name" autocomplete="off" spellcheck="false" placeholder="${esc(name)}" /></label>
      <p class="error" id="modal-error"></p>
      <div class="modal-actions"><button class="btn ghost" id="purge-cancel" type="button">Abbrechen</button><button class="btn danger" id="purge-go" type="button" disabled>Endgültig löschen</button></div>`, (root) => {
      const input = $('#purge-name', root);
      const go = $('#purge-go', root);
      input.addEventListener('input', () => { go.disabled = input.value !== name; });
      $('#purge-cancel', root).addEventListener('click', closeModal);
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await del(`/api/projects/${b.dataset.purge}/permanent`, { confirm_name: input.value });
          closeModal();
          toast(`Projekt „${name}“ endgültig gelöscht`, 'success');
          renderProjects(el);
        } catch (err) {
          setModalError(root, err.message);
          go.disabled = false;
        }
      });
    });
  }));

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
