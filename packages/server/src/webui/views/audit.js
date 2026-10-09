import { get } from '../lib/api.js';
import { $, esc, badge, fmtDate } from '../lib/ui.js';
import { state } from '../lib/api.js';

export async function renderAudit(el, query) {
  const params = new URLSearchParams(query ?? '');
  const isAdmin = state.user.system_role === 'admin';
  const projectId = params.get('project_id') || (isAdmin ? '' : state.memberships[0]?.project_id ?? '');

  const projectOptions = state.memberships
    .map((m) => `<option value="${esc(m.project_id)}" ${m.project_id === projectId ? 'selected' : ''}>${esc(m.name)}</option>`)
    .join('');

  let entries = [];
  let loadError = null;
  if (!isAdmin && !projectId) {
    loadError = null; // keine Mitgliedschaften -> einfach leere Liste, kein API-Aufruf nötig
  } else {
    try {
      entries = projectId
        ? await get(`/api/audit?project_id=${encodeURIComponent(projectId)}`)
        : await get('/api/audit/all');
    } catch (err) {
      loadError = err.message;
    }
  }

  const rows = entries.map((a) => `
    <tr>
      <td class="muted text-sm">${fmtDate(a.created_at)}</td>
      <td><span class="mono text-sm">${esc(a.action)}</span></td>
      <td class="muted text-sm">${esc(a.actor_label || a.actor_type)}</td>
      <td>${badge(a.result, a.result)}</td>
      <td class="muted text-sm mono">${esc(a.detail_json || '')}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Audit-Log</h1>
        <p class="lede">Sicherheitsrelevante Aktionen (Login, Enrollment, Secret-Reveal, Provisioning, …). Secret-Werte erscheinen hier nie.</p>
      </div>
      <div class="page-actions">
        <select id="audit-project">
          ${isAdmin ? `<option value="">Alle Projekte (global)</option>` : ''}
          ${projectOptions}
        </select>
      </div>
    </div>
    ${loadError ? `<div class="alert danger">${esc(loadError)}</div>` : ''}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Akteur</th><th>Ergebnis</th><th>Detail</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5"><div class="empty-state">Keine Einträge.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#audit-project', el).addEventListener('change', (e) => {
    location.hash = `#/audit${e.target.value ? `?project_id=${e.target.value}` : ''}`;
  });
}
