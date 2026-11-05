import { get } from '../../lib/api.js';
import { $, esc, badge, fmtDate } from '../../lib/ui.js';
import { icon } from '../../lib/icons.js';

const KIND = { backup: 'Backup', restore: 'Restore', agent: 'Agent' };

export async function renderBackupLog(el, project) {
  let onlyErrors = false;
  const load = async () => {
    const all = await get(`/api/projects/${project.id}/backup-log`);
    const entries = onlyErrors ? all.filter((e) => e.level === 'error') : all;
    $('#backuplog-body', el).innerHTML = entries.map((e) => `
      <tr>
        <td class="muted text-sm">${fmtDate(e.at)}</td>
        <td>${badge(e.level === 'error' ? 'Fehler' : 'ok', e.level === 'error' ? 'failed' : 'ok')}</td>
        <td class="text-sm">${esc(KIND[e.kind] || e.kind)}<br><span class="muted">${esc(e.job || '–')}</span></td>
        <td class="muted text-sm">${esc(e.machine || '–')}</td>
        <td><strong class="text-sm">${esc(e.title)}</strong>${e.message ? `<div class="mono text-sm" style="white-space:pre-wrap">${esc(e.message)}</div>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">Keine Einträge.</div></td></tr>';
  };

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Backup-Log</h2>
        <div class="btn-group">
          <label class="checkbox-row"><input type="checkbox" id="only-errors" /> nur Fehler</label>
          <button class="btn ghost sm" id="btn-refresh-blog">${icon('info')}Aktualisieren</button>
        </div>
      </div>
      <p class="text-sm muted">Alle Backup- und Restore-Läufe dieses Projekts, auch nicht gestartete geplante Backups (z. B. Maschine offline) und fehlgeschlagene Agent-Aufträge.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Zeit</th><th>Status</th><th>Art / Job</th><th>Maschine</th><th>Meldung</th></tr></thead>
          <tbody id="backuplog-body"><tr><td colspan="5" class="muted">Lade…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  await load();
  $('#only-errors', el).addEventListener('change', (e) => { onlyErrors = e.target.checked; load().catch(() => {}); });
  $('#btn-refresh-blog', el).addEventListener('click', () => load().catch(() => {}));
  const timer = setInterval(() => {
    if (!el.isConnected || !$('#backuplog-body', el)) { clearInterval(timer); return; }
    load().catch(() => {});
  }, 10000);
}
