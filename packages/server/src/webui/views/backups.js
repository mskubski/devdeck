import { get, post } from '../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function renderBackups(el) {
  const info = await get('/api/backups');
  const rows = info.backups.map((b) => `
    <tr>
      <td class="muted text-sm">${fmtDate(b.created_at)}</td>
      <td>${badge(b.status, b.status)}</td>
      <td class="muted text-sm">${fmtBytes(b.size_bytes)}</td>
      <td class="muted text-sm">${b.verified_at ? fmtDate(b.verified_at) : 'nicht geprüft'}</td>
      <td class="muted text-sm mono">${esc(b.target_path)}${b.error ? `<br><span class="error">${esc(b.error)}</span>` : ''}</td>
      <td class="actions">${b.status === 'success' ? `<button class="btn ghost sm" data-verify="${b.id}">Prüfen</button>` : ''}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Backups</h1>
        <p class="lede">System-Backups von Datenbank und Vault (verschlüsselte Werte). Der Vault-Key wird nie mitgesichert – separat aufbewahren.</p>
      </div>
      <div class="page-actions"><button class="btn" id="btn-backup">${icon('plus')}Backup jetzt erstellen</button></div>
    </div>
    <div class="card">
      <p class="text-sm muted">
        Ziel: <span class="mono">${esc(info.target)}</span> ·
        Automatik: ${info.interval_hours > 0 ? `alle ${info.interval_hours} h` : 'aus'} ·
        Aufbewahrung: ${info.retention.daily} täglich + ${info.retention.weekly} wöchentlich
      </p>
      <p class="text-sm muted">Wiederherstellung ist aus Sicherheitsgründen nur im Terminal möglich:
        <code>node packages/server/dist/restore.js &lt;backup-ordner&gt;</code> (Server vorher stoppen).</p>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Erstellt</th><th>Status</th><th>Größe</th><th>Geprüft</th><th>Pfad</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty-state">Noch keine Backups.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-backup', el).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await post('/api/backups');
      toast('Backup erstellt', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderBackups(el);
  });
  $$('[data-verify]', el).forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const r = await post(`/api/backups/${btn.dataset.verify}/verify`);
      toast(r.ok ? 'Backup ist intakt' : `Fehler: ${r.problems.join('; ')}`, r.ok ? 'success' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderBackups(el);
  }));
}
