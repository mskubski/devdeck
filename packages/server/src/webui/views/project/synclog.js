import { get } from '../../lib/api.js';
import { $, esc, badge, fmtDate } from '../../lib/ui.js';
import { icon } from '../../lib/icons.js';

const ACTION_LABEL = { 'workspace.sync': 'Sync', 'workspace.provision': 'Provision' };
const STATUS_LABEL = { queued: 'wartet', running: 'läuft', done: 'erledigt', failed: 'fehlgeschlagen', expired: 'abgelaufen' };

function details(entry) {
  const parts = [];
  if (entry.error) parts.push(`<div class="mono text-sm" style="white-space:pre-wrap">${esc(entry.error)}</div>`);
  const steps = entry.result?.steps;
  if (Array.isArray(steps)) {
    parts.push(`<ul class="text-sm">${steps.map((s) =>
      `<li>${esc(s.step)}: ${esc(s.status)}${s.detail ? ` – ${esc(s.detail)}` : ''}</li>`).join('')}</ul>`);
  }
  if (entry.status === 'queued') parts.push('<span class="muted text-sm">Noch nicht vom Agent abgeholt – läuft der Agent auf dieser Maschine?</span>');
  if (entry.status === 'expired') parts.push('<span class="muted text-sm">Der Agent hat den Auftrag nicht rechtzeitig abgeholt.</span>');
  return parts.join('') || '<span class="muted text-sm">–</span>';
}

export async function renderSyncLog(el, project) {
  const load = async () => {
    const entries = await get(`/api/projects/${project.id}/sync-log`);
    const rows = entries.map((e) => `
      <tr>
        <td class="muted text-sm">${fmtDate(e.created_at)}</td>
        <td>${esc(ACTION_LABEL[e.action] || e.action)}</td>
        <td class="muted text-sm">${esc(e.machine_name || e.machine_id)}</td>
        <td><span class="mono text-sm">${esc(e.local_path || '–')}</span></td>
        <td>${badge(STATUS_LABEL[e.status] || e.status, e.status)}</td>
        <td class="muted text-sm">${e.finished_at ? fmtDate(e.finished_at) : '–'}</td>
        <td>${details(e)}</td>
      </tr>`).join('');
    $('#synclog-body', el).innerHTML = rows
      || '<tr><td colspan="7"><div class="empty-state">Noch keine Sync-/Provision-Aufträge.</div></td></tr>';
  };

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Sync-Log</h2>
        <button class="btn ghost sm" id="btn-refresh-log">${icon('info')}Aktualisieren</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Beauftragt</th><th>Aktion</th><th>Maschine</th><th>Pfad</th><th>Status</th><th>Beendet</th><th>Details</th></tr></thead>
          <tbody id="synclog-body"><tr><td colspan="7" class="muted">Lade…</td></tr></tbody>
        </table>
      </div>
    </div>`;

  await load();
  $('#btn-refresh-log', el).addEventListener('click', () => load().catch(() => {}));
  // Automatisch aktualisieren, solange der Tab sichtbar ist
  const timer = setInterval(() => {
    if (!el.isConnected || !$('#synclog-body', el)) { clearInterval(timer); return; }
    load().catch(() => {});
  }, 5000);
}
