import { get, post } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, confirmModal } from '../../lib/ui.js';
import { icon } from '../../lib/icons.js';

const ACTION_LABEL = { 'workspace.sync': 'Sync', 'workspace.push': 'Push', 'workspace.provision': 'Provision', 'workspace.deploy': 'Deploy' };
const STATUS_LABEL = { queued: 'wartet', running: 'läuft', done: 'erledigt', failed: 'fehlgeschlagen', expired: 'abgelaufen' };

function details(entry, canMerge) {
  const parts = [];
  if (entry.error) parts.push(`<div class="mono text-sm" style="white-space:pre-wrap">${esc(entry.error)}</div>`);
  const steps = entry.result?.steps;
  if (Array.isArray(steps)) {
    parts.push(`<ul class="text-sm">${steps.map((s) =>
      `<li>${esc(s.step)}: ${esc(s.status)}${s.detail ? ` – ${esc(s.detail)}` : ''}</li>`).join('')}</ul>`);
  }
  if (canMerge) {
    parts.push(`<button class="btn sm" type="button" data-merge="${esc(entry.workspace_id)}" style="margin-top:var(--space-2)">${icon('layers', { size: 16 })}<span>Zusammenführen &amp; syncen</span></button>`);
  }
  if (entry.status === 'queued') parts.push('<span class="muted text-sm">Noch nicht vom Agent abgeholt – läuft der Agent auf dieser Maschine?</span>');
  if (entry.status === 'expired') parts.push('<span class="muted text-sm">Der Agent hat den Auftrag nicht rechtzeitig abgeholt.</span>');
  return parts.join('') || '<span class="muted text-sm">–</span>';
}

export async function renderSyncLog(el, project) {
  const load = async () => {
    const entries = await get(`/api/projects/${project.id}/sync-log`);
    // „Zusammenführen & syncen“ nur beim jeweils letzten Sync je Workspace, wenn er an einem abgewichenen Branch scheiterte
    const seen = new Set();
    const mergeable = new Set();
    for (const e of entries) {
      if (e.action !== 'workspace.sync' || !e.workspace_id || seen.has(e.workspace_id)) continue;
      seen.add(e.workspace_id);
      if (e.status === 'failed' && String(e.error || '').includes('Branch abgewichen')) mergeable.add(e.id);
    }
    const rows = entries.map((e) => `
      <tr>
        <td class="muted text-sm">${fmtDate(e.created_at)}</td>
        <td>${esc(ACTION_LABEL[e.action] || e.action)}</td>
        <td class="muted text-sm">${esc(e.machine_name || e.machine_id)}</td>
        <td><span class="mono text-sm">${esc(e.local_path || '–')}</span></td>
        <td>${badge(STATUS_LABEL[e.status] || e.status, e.status)}</td>
        <td class="muted text-sm">${e.finished_at ? fmtDate(e.finished_at) : '–'}</td>
        <td>${details(e, mergeable.has(e.id))}</td>
      </tr>`).join('');
    $('#synclog-body', el).innerHTML = rows
      || '<tr><td colspan="7"><div class="empty-state">Noch keine Sync-/Provision-Aufträge.</div></td></tr>';
    for (const b of $$('[data-merge]', el)) {
      b.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: 'Zusammenführen & syncen',
          message: 'Der Remote-Stand wird per Merge-Commit in den Branch der Maschine geführt. Lokale Commits bleiben erhalten, bei Konflikten wird abgebrochen und nichts verändert. Gepusht wird dabei nichts.',
          confirmLabel: 'Zusammenführen & syncen',
          danger: false,
        });
        if (!ok) return;
        try {
          await post(`/api/workspaces/${b.dataset.merge}/sync`, { strategy: 'merge' });
          toast('Zusammenführen & Sync beauftragt', 'success');
          load().catch(() => {});
        } catch (err) { toast(err.message, 'error'); }
      });
    }
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
