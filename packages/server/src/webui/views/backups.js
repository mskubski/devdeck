import { get, post, put, del } from '../lib/api.js';
import { replicaModal, replicaStatusHtml } from '../lib/replica.js';
import { $, $$, esc, badge, fmtDate, toast, confirmModal } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function replicaRows(overview) {
  const row = (key, label, sub, count, replica) => `
    <tr>
      <td><strong>${label}</strong><br><span class="muted text-sm mono">${sub}</span></td>
      <td class="muted text-sm">${count}</td>
      <td class="text-sm">${replica ? `${esc(replica.machine?.name ?? '?')}<br><span class="mono muted">${esc(replica.target_dir)}</span>` : '<span class="muted">–</span>'}</td>
      <td>${replicaStatusHtml(replica)}</td>
      <td class="actions">
        <button class="btn ghost sm" data-rep-set="${esc(key)}">${icon('copy', { size: 14 })}${replica ? 'Ändern' : 'Einrichten'}</button>
        ${replica ? `<button class="btn ghost sm" data-rep-sync="${esc(key)}" ${replica.busy ? 'disabled' : ''}>Abgleichen</button>
        <button class="btn ghost sm danger" data-rep-del="${esc(key)}">Entfernen</button>` : ''}
      </td>
    </tr>`;
  const sys = overview.system;
  const rows = [row('system', 'DevDeck-System-Backups', esc(sys.source.dir), sys.source.backups, sys.replica)];
  for (const j of overview.jobs) {
    rows.push(row(`job:${j.project.id}:${j.id}`, `${esc(j.project.name)} – ${esc(j.name)}`, `${esc(j.source.machine)}: ${esc(j.source.dir)}`, j.source.backups, j.replica));
  }
  return rows.join('');
}

export async function renderBackups(el) {
  const info = await get('/api/backups');
  const overview = await get('/api/backup-replicas');
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
    <div class="card" id="replica-card">
      <div class="card-head"><h2>Replikation auf eine zweite Maschine</h2></div>
      <p class="text-sm muted">
        Jedes Backup lässt sich zusätzlich auf einer zweiten Maschine ablegen – für DevDeck selbst und für die Backups aller Projekte. Erst-Backup und Replik liegen so auf zwei Maschinen;
        löscht die Aufbewahrung beim Primär-Backup ein Backup, verschwindet es auch auf der Replik. Der Ordner auf der Ziel-Maschine ist frei wählbar (Vorschlag: derselbe Pfad wie beim Primären bzw. ein neuer Ordner neben dem Workspace-Root).
        Die Kopie läuft über den DevDeck-Server (Agenten verbinden sich nur ausgehend) und wird Datei für Datei per Prüfsumme kontrolliert.
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Quelle</th><th>Backups</th><th>Replik (Ziel)</th><th>Stand</th><th></th></tr></thead>
          <tbody>${replicaRows(overview)}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Erstellt</th><th>Status</th><th>Größe</th><th>Geprüft</th><th>Pfad</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty-state">Noch keine Backups.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  // Replikation: Einrichten/Ändern/Abgleichen/Entfernen (System-Backups und Projekt-Jobs)
  const entry = (key) => (key === 'system'
    ? { title: 'Replik der DevDeck-System-Backups', source: `${overview.system.source.label}, <span class="mono">${esc(overview.system.source.dir)}</span>`, machines: overview.system.machines, replica: overview.system.replica, base: '/api/backups/replica' }
    : (() => {
      const [, projectId, jobId] = key.split(':');
      const j = overview.jobs.find((x) => x.id === jobId);
      return { title: `Replik für ${j.project.name} – ${j.name}`, source: `${esc(j.source.machine)}, <span class="mono">${esc(j.source.dir)}</span>`, machines: j.machines, replica: j.replica, base: `/api/projects/${projectId}/backup-jobs/${jobId}/replica` };
    })());
  $$('[data-rep-set]', el).forEach((b) => b.addEventListener('click', () => {
    const e = entry(b.dataset.repSet);
    replicaModal({
      title: e.title,
      intro: `Die vorhandenen und künftigen Backups von ${e.source} werden zusätzlich auf eine zweite Maschine kopiert.`,
      machines: e.machines,
      current: e.replica,
      onSave: async (payload) => {
        await put(e.base, payload);
        toast('Replik eingerichtet – der Abgleich startet gleich', 'success');
        renderBackups(el);
      },
    });
  }));
  $$('[data-rep-sync]', el).forEach((b) => b.addEventListener('click', async () => {
    try {
      await post(`${entry(b.dataset.repSync).base}/sync`);
      toast('Abgleich angestoßen', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderBackups(el);
  }));
  $$('[data-rep-del]', el).forEach((b) => b.addEventListener('click', async () => {
    const e = entry(b.dataset.repDel);
    const ok = await confirmModal({
      title: 'Replik entfernen?',
      message: `Die Replik wird nicht mehr abgeglichen. Bereits kopierte Backups bleiben auf ${e.replica.machine?.name ?? 'der Ziel-Maschine'} in ${e.replica.target_dir} liegen.`,
      confirmLabel: 'Replik entfernen',
    });
    if (!ok) return;
    try {
      await del(e.base, { confirm: true });
      toast('Replik entfernt', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderBackups(el);
  }));
  // Solange eine Kopie läuft, die Ansicht alle paar Sekunden erneuern (nur solange sie offen ist und kein Dialog)
  if (overview.system.replica?.busy || overview.jobs.some((j) => j.replica?.busy)) {
    setTimeout(() => { if (el.isConnected && !document.querySelector('.modal')) renderBackups(el); }, 5000);
  }

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
