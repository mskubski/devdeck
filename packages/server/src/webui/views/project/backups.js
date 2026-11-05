import { get, post, put, patch, del } from '../../lib/api.js';
import { replicaModal, replicaStatusHtml } from '../../lib/replica.js';
import { $, $$, esc, badge, fmtDate, toast, confirmModal, closeModal, openModal, setModalError } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

/** Muss exakt dem Text des Servers entsprechen (RESTORE_CONFIRM_PHRASE). */
const RESTORE_PHRASE = 'Restore starten';
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const KIND_LABEL = { supabase: 'Supabase', postgres: 'PostgreSQL', sqlite: 'SQLite', files: 'Ordner' };

function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function scheduleText(s) {
  if (!s || s.mode === 'off') return 'kein Zeitplan (nur manuell)';
  if (s.mode === 'daily') return `täglich um ${s.time} Uhr`;
  if (s.mode === 'weekly') return `wöchentlich, ${WEEKDAYS[s.weekday]} um ${s.time} Uhr`;
  return `alle ${s.every_hours} Stunden`;
}

function contentText(b) {
  const s = b.summary || {};
  const parts = [];
  if (s.tables != null) parts.push(`${s.tables} Tabellen`);
  if (s.rows != null) parts.push(`${Number(s.rows).toLocaleString('de-DE')} Zeilen`);
  if (s.storage_files != null) parts.push(`${s.storage_files} Dateien im Storage`);
  if (Array.isArray(s.sources)) {
    const others = s.sources.filter((x) => x.kind !== 'supabase');
    if (others.length) parts.push(others.map((x) => `${esc(x.label)} (${fmtBytes(x.bytes)})`).join(', '));
  }
  return parts.join(' · ') || '–';
}

function statusBadge(b) {
  const label = { queued: 'wartet', running: 'läuft', success: 'ok', failed: 'Fehler' }[b.status] ?? b.status;
  return badge(label, b.status);
}

const TRIGGER_LABEL = { manual: 'manuell', schedule: 'Zeitplan', 'restore-safety': 'vor Restore', discovered: 'vorhanden' };

function backupRows(job, canEdit, canRestore) {
  if (job.backups.length === 0) return `<tr><td colspan="6"><div class="empty-state">Noch keine Backups.</div></td></tr>`;
  return job.backups.map((b) => {
    const verify = b.verify
      ? (b.verify.ok ? badge('geprüft', 'ok') : `<span class="badge bad" title="${esc(b.verify.problems.join('\n'))}">Prüfung fehlgeschlagen</span>`)
      : '<span class="muted text-sm">nicht geprüft</span>';
    const busy = b.status === 'queued' || b.status === 'running';
    return `
      <tr>
        <td class="text-sm">${esc(b.bundle_name || '…')}<br><span class="muted">${fmtDate(b.created_at)}</span></td>
        <td>${statusBadge(b)}${busy && b.progress ? `<br><span class="muted text-sm">${esc(b.progress)}</span>` : ''}${b.error ? `<br><span class="error text-sm">${esc(b.error)}</span>` : ''}</td>
        <td class="muted text-sm">${esc(TRIGGER_LABEL[b.trigger] ?? b.trigger)}</td>
        <td class="muted text-sm">${fmtBytes(b.size_bytes)}</td>
        <td class="muted text-sm">${b.status === 'success' ? contentText(b) : ''}</td>
        <td>${b.status === 'success' ? verify : ''}</td>
        <td class="actions">${b.status === 'success' ? `
          ${canEdit ? `<button class="btn ghost sm" data-verify="${esc(job.id)}:${esc(b.id)}">Prüfen</button>` : ''}
          ${canRestore ? `<button class="btn ghost sm danger" data-restore="${esc(job.id)}:${esc(b.id)}">Restore …</button>` : ''}` : ''}</td>
      </tr>`;
  }).join('');
}

function restoresHtml(job) {
  if (!job.restores.length) return '';
  return `<p class="text-sm muted" style="margin-top:var(--space-3)"><strong>Letzte Restores:</strong> ${job.restores.map((r) => {
    const label = { running: 'läuft', success: 'ok', failed: 'Fehler' }[r.status] ?? r.status;
    return `${esc(r.bundle_name)} – ${esc(label)} (${fmtDate(r.started_at)}, ${esc(r.requested_by || '?')})${r.status === 'running' && r.progress ? ` – ${esc(r.progress)}` : ''}${r.error ? ` <span class="error">${esc(r.error)}</span>` : ''}${r.summary?.previous_state_saved_in ? ` <span class="mono">Vorheriger Stand: ${esc(r.summary.previous_state_saved_in)}</span>` : ''}`;
  }).join('<br>')}</p>`;
}

function jobCard(job, canEdit, canRestore) {
  const m = job.machine;
  const next = job.next_run_at && job.enabled ? fmtDate(job.next_run_at) : '–';
  return `
    <div class="card" data-job="${esc(job.id)}">
      <div class="card-head">
        <h2>${esc(job.name)} ${job.enabled ? '' : badge('pausiert', 'warn')} ${job.busy ? badge('arbeitet …', 'warn') : ''}</h2>
        ${canEdit ? `<div class="btn-group">
          <button class="btn sm" data-run="${esc(job.id)}" ${job.busy || job.machine?.agent_status !== 'online' ? 'disabled' : ''}>${icon('plus', { size: 14 })}Jetzt sichern</button>
          <button class="btn ghost sm" data-scan="${esc(job.id)}">Ordner neu einlesen</button>
          <button class="btn ghost sm" data-edit="${esc(job.id)}">Bearbeiten</button>
          <button class="btn ghost sm danger" data-delete="${esc(job.id)}">Job löschen</button>
        </div>` : ''}
      </div>
      <p class="text-sm muted">
        Maschine: <strong>${esc(m?.name ?? '?')}</strong> ${m ? badge(m.agent_status, m.agent_status) : ''} ·
        Ordner: <span class="mono">${esc(job.target_dir)}</span><br>
        Zeitplan: ${esc(scheduleText(job.schedule))} (Serverzeit) · nächster Lauf: ${esc(next)} ·
        Aufbewahrung: ${job.retention.keep_days} Tage, mindestens ${job.retention.keep_min} Backups<br>
        ${job.stats.count} Backups, ${fmtBytes(job.stats.total_bytes)}${job.stats.newest_success_at ? `, letztes: ${fmtDate(job.stats.newest_success_at)}` : ''}
      </p>
      <div class="text-sm replica-line" style="margin:var(--space-2) 0">
        <strong>Replik:</strong> ${job.replica
          ? `<span class="muted">${esc(job.replica.machine?.name ?? '?')}:</span> <span class="mono">${esc(job.replica.target_dir)}</span> · ${replicaStatusHtml(job.replica)}`
          : '<span class="muted">keine – die Backups liegen nur auf dieser Maschine</span>'}
        ${canEdit ? `<span class="btn-group" style="margin-left:var(--space-2)">
          <button class="btn ghost sm" data-replica="${esc(job.id)}">${icon('copy', { size: 14 })}${job.replica ? 'Replik ändern' : 'Auf zweite Maschine sichern'}</button>
          ${job.replica ? `<button class="btn ghost sm" data-replica-sync="${esc(job.id)}" ${job.replica.busy ? 'disabled' : ''}>Jetzt abgleichen</button>
          <button class="btn ghost sm danger" data-replica-del="${esc(job.id)}">Replik entfernen</button>` : ''}
        </span>` : ''}
      </div>
      <p class="text-sm">${job.sources.map((s) => `<span class="badge ${s.enabled ? 'accent' : ''}" title="${esc(s.config.path || s.config.url_secret || '')}">${esc(KIND_LABEL[s.kind])}: ${esc(s.label)}${s.enabled ? '' : ' (aus)'}</span>`).join(' ')}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Backup</th><th>Status</th><th>Auslöser</th><th>Größe</th><th>Inhalt</th><th>Prüfung</th><th></th></tr></thead>
          <tbody>${backupRows(job, canEdit, canRestore)}</tbody>
        </table>
      </div>
      ${restoresHtml(job)}
    </div>`;
}

export async function renderBackups(el, project) {
  const canEdit = roleAtLeast(project.role, 'maintainer');
  const canRestore = roleAtLeast(project.role, 'owner');
  const jobs = await get(`/api/projects/${project.id}/backup-jobs`);
  const reload = () => renderBackups(el, project);

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Backups dieses Projekts</h2>
        ${canEdit ? `<button class="btn" id="btn-new-job">${icon('plus')}Backup einrichten</button>` : ''}
      </div>
      <p class="text-sm muted">
        DevDeck erkennt automatisch, was zu sichern ist (Datenbank und Storage aus den Vault-Secrets, SQLite-Dateien, Datenordner),
        legt die Backups auf einer beliebigen eingetragenen Maschine ab, führt sie nach Zeitplan aus und räumt nach der eingestellten Aufbewahrung auf.
        Bereits vorhandene Backups im Zielordner werden erkannt und übernommen.
      </p>
      <p class="text-sm muted">
        <strong>Restore</strong> ist nur für Projekt-Owner möglich, nur hier in der Web-Oberfläche, mit zusätzlicher Abfrage und der Eingabe von
        „${RESTORE_PHRASE}“. Vorher wird automatisch ein Sicherheits-Backup des aktuellen Zustands erstellt. System-Backups (DevDeck selbst): Menü „Backups“.
      </p>
    </div>
    ${jobs.map((j) => jobCard(j, canEdit, canRestore)).join('') || '<div class="card"><div class="empty-state">Noch kein Backup eingerichtet.</div></div>'}`;

  $('#btn-new-job', el)?.addEventListener('click', () => jobModal(project, null, reload));
  const find = (id) => jobs.find((j) => j.id === id);
  const act = async (fn, okText) => {
    try {
      await fn();
      if (okText) toast(okText, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    reload();
  };
  $$('[data-run]', el).forEach((b) => b.addEventListener('click', () => act(() => post(`/api/projects/${project.id}/backup-jobs/${b.dataset.run}/run`), 'Backup gestartet')));
  $$('[data-scan]', el).forEach((b) => b.addEventListener('click', () => act(() => post(`/api/projects/${project.id}/backup-jobs/${b.dataset.scan}/scan`), 'Ordner wird eingelesen – gleich neu laden')));
  $$('[data-replica]', el).forEach((b) => b.addEventListener('click', async () => {
    const job = find(b.dataset.replica);
    let machines;
    try {
      machines = await get(`/api/projects/${project.id}/backup-jobs/${job.id}/replica-options`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    replicaModal({
      title: `Replik für „${job.name}“`,
      intro: `Die Backups dieses Jobs (Quelle: <strong>${esc(job.machine?.name ?? '?')}</strong>, <span class="mono">${esc(job.target_dir)}</span>) werden zusätzlich auf eine zweite Maschine kopiert – auch bereits vorhandene.`,
      machines,
      current: job.replica,
      onSave: async (payload) => {
        await put(`/api/projects/${project.id}/backup-jobs/${job.id}/replica`, payload);
        toast('Replik eingerichtet – der Abgleich startet gleich', 'success');
        reload();
      },
    });
  }));
  $$('[data-replica-sync]', el).forEach((b) => b.addEventListener('click', () => act(() => post(`/api/projects/${project.id}/backup-jobs/${b.dataset.replicaSync}/replica/sync`), 'Abgleich angestoßen')));
  $$('[data-replica-del]', el).forEach((b) => b.addEventListener('click', async () => {
    const job = find(b.dataset.replicaDel);
    const ok = await confirmModal({
      title: 'Replik entfernen?',
      message: `Die Replik von „${job.name}“ wird nicht mehr abgeglichen. Bereits kopierte Backups bleiben auf ${job.replica.machine?.name ?? 'der Ziel-Maschine'} in ${job.replica.target_dir} liegen.`,
      confirmLabel: 'Replik entfernen',
    });
    if (ok) act(() => del(`/api/projects/${project.id}/backup-jobs/${job.id}/replica`, { confirm: true }), 'Replik entfernt');
  }));
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => jobModal(project, find(b.dataset.edit), reload)));
  $$('[data-delete]', el).forEach((b) => b.addEventListener('click', async () => {
    const job = find(b.dataset.delete);
    const ok = await confirmModal({
      title: `Job „${job.name}“ löschen?`,
      message: `Der Job und seine Einträge in DevDeck werden gelöscht. Die Backup-Dateien in ${job.target_dir} bleiben unangetastet.`,
      confirmLabel: 'Job löschen',
    });
    if (ok) act(() => del(`/api/projects/${project.id}/backup-jobs/${job.id}`, { confirm: true }), 'Job gelöscht');
  }));
  $$('[data-verify]', el).forEach((b) => b.addEventListener('click', () => {
    const [jobId, backupId] = b.dataset.verify.split(':');
    act(() => post(`/api/projects/${project.id}/backup-jobs/${jobId}/backups/${backupId}/verify`), 'Prüfung gestartet – Ergebnis erscheint in Kürze');
  }));
  $$('[data-restore]', el).forEach((b) => b.addEventListener('click', () => {
    const [jobId, backupId] = b.dataset.restore.split(':');
    const job = find(jobId);
    restoreModal(project, job, job.backups.find((x) => x.id === backupId), reload);
  }));

  // Solange etwas läuft: automatisch aktualisieren (nur solange diese Ansicht noch offen ist)
  if (jobs.some((j) => j.busy || j.replica?.busy) || jobs.some((j) => j.backups.some((b) => b.status === 'queued' || b.status === 'running'))) {
    setTimeout(() => { if (el.isConnected && !document.querySelector('.modal')) reload(); }, 4000);
  }
}

// ── Restore: zweistufig (Warnung, dann wörtliche Eingabe) ──

function restoreModal(project, job, backup, onDone) {
  openModal(`
    <h2>Restore starten?</h2>
    <div class="alert danger">
      <p><strong>Achtung: Dies überschreibt den aktuellen Stand.</strong></p>
      <p class="text-sm">Backup <span class="mono">${esc(backup.bundle_name)}</span> vom ${esc(fmtDate(backup.created_at))} wird auf <strong>${esc(job.machine?.name ?? '?')}</strong> zurückgespielt.</p>
    </div>
    <ul class="text-sm">
      <li>Vorher wird automatisch ein <strong>Sicherheits-Backup</strong> des aktuellen Zustands erstellt. Schlägt es fehl, wird nichts verändert.</li>
      <li>Ordner und SQLite-Dateien werden nicht überschrieben, sondern in einen Ordner <span class="mono">_pre-restore-…</span> neben den Backups verschoben.</li>
      <li>Supabase wird per Upsert zurückgeschrieben (vorhandene Zeilen werden überschrieben, nichts wird gelöscht).</li>
      <li>Laufende Anwendungen, die diese Daten nutzen, sollten vorher beendet werden.</li>
    </ul>
    <p class="text-sm"><strong>Was soll wiederhergestellt werden?</strong></p>
    <div class="stack">
      ${job.sources.filter((s) => s.enabled).map((s) => `<label class="checkbox-row"><input type="checkbox" name="src" value="${esc(s.id)}" checked /> ${esc(KIND_LABEL[s.kind])}: ${esc(s.label)}</label>`).join('')}
    </div>
    <label>Zur Bestätigung bitte <strong>${RESTORE_PHRASE}</strong> eintippen
      <input id="restore-confirm" autocomplete="off" spellcheck="false" placeholder="${RESTORE_PHRASE}" />
    </label>
    <p class="error" id="modal-error"></p>
    <div class="modal-actions">
      <button class="btn ghost" id="restore-cancel" type="button">Abbrechen</button>
      <button class="btn danger" id="restore-go" type="button" disabled>Restore starten</button>
    </div>`, (root) => {
    const input = $('#restore-confirm', root);
    const go = $('#restore-go', root);
    input.addEventListener('input', () => { go.disabled = input.value !== RESTORE_PHRASE; });
    $('#restore-cancel', root).addEventListener('click', closeModal);
    go.addEventListener('click', async () => {
      if (input.value !== RESTORE_PHRASE) return;
      go.disabled = true;
      try {
        const source_ids = $$('input[name=src]:checked', root).map((c) => c.value);
        if (!source_ids.length) throw new Error('Bitte mindestens eine Quelle auswählen');
        await post(`/api/projects/${project.id}/backup-jobs/${job.id}/backups/${backup.id}/restore`, { confirm_text: input.value, source_ids });
        closeModal();
        toast('Restore gestartet – zuerst läuft das Sicherheits-Backup', 'success');
        onDone();
      } catch (err) {
        setModalError(root, err.message);
        go.disabled = input.value !== RESTORE_PHRASE;
      }
    });
    input.focus();
  });
}

// ── Job anlegen / bearbeiten ──

async function jobModal(project, job, onDone) {
  let machines;
  try {
    machines = await get(`/api/projects/${project.id}/backup-machines`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const usable = machines.filter((m) => m.supported);
  if (!machines.length) { toast('Es ist noch keine Maschine eingetragen', 'error'); return; }
  const preferred = job ? job.machine.id : (usable.find((m) => m.agent_status === 'online' && m.workspaces.length) ?? usable.find((m) => m.agent_status === 'online') ?? machines[0]).id;
  const sch = job?.schedule ?? { mode: 'daily', time: '03:00', weekday: 1, every_hours: 24 };
  const ret = job?.retention ?? { keep_days: 30, keep_min: 5 };

  openModal(`
    <h2>${job ? 'Backup-Job bearbeiten' : 'Backup einrichten'}</h2>
    <form id="job-form" class="stack">
      <label>Name <input name="name" value="${esc(job?.name ?? 'Standard')}" maxlength="120" required /></label>
      <label>Maschine, auf der die Backups liegen
        <select name="machine_id">${machines.map((m) => `<option value="${esc(m.id)}" ${m.id === preferred ? 'selected' : ''} ${m.supported ? '' : 'disabled'}>${esc(m.name)} (${esc(m.platform)}, ${esc(m.agent_status)}${m.supported ? '' : ', Agent zu alt'})</option>`).join('')}</select>
      </label>
      <label>Backup-Ordner auf dieser Maschine <input name="target_dir" value="${esc(job?.target_dir ?? '')}" maxlength="500" placeholder="/pfad/zu/backups" required /></label>
      <div id="found-dirs" class="text-sm"></div>

      <div>
        <strong>Was wird gesichert?</strong> <button class="btn ghost sm" type="button" id="btn-detect">Neu erkennen</button>
        <div id="detect-state" class="text-sm muted">Erkenne …</div>
        <div id="sources" class="stack"></div>
        <div id="notes" class="text-sm muted"></div>
      </div>

      <div class="grid cols-2">
        <label>Zeitplan
          <select name="mode">
            <option value="daily" ${sch.mode === 'daily' ? 'selected' : ''}>täglich</option>
            <option value="weekly" ${sch.mode === 'weekly' ? 'selected' : ''}>wöchentlich</option>
            <option value="interval" ${sch.mode === 'interval' ? 'selected' : ''}>alle N Stunden</option>
            <option value="off" ${sch.mode === 'off' ? 'selected' : ''}>nur manuell</option>
          </select>
        </label>
        <label data-sch="daily weekly">Uhrzeit (Serverzeit) <input name="time" type="time" value="${esc(sch.time)}" /></label>
        <label data-sch="weekly">Wochentag
          <select name="weekday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${i === sch.weekday ? 'selected' : ''}>${d}</option>`).join('')}</select>
        </label>
        <label data-sch="interval">Alle … Stunden <input name="every_hours" type="number" min="1" max="720" value="${sch.every_hours}" /></label>
      </div>
      <div class="grid cols-2">
        <label>Backups aufbewahren (Tage) <input name="keep_days" type="number" min="1" max="3650" value="${ret.keep_days}" /></label>
        <label>Mindestens behalten (Anzahl) <input name="keep_min" type="number" min="1" max="1000" value="${ret.keep_min}" /></label>
      </div>
      <p class="text-sm muted">Ältere Backups werden nach einem erfolgreichen Lauf gelöscht – die neuesten „Mindestens behalten“ bleiben immer erhalten.
        Das gilt auch für bereits vorhandene Backups im Ordner.</p>
      <label class="checkbox-row"><input type="checkbox" name="enabled" ${job && !job.enabled ? '' : 'checked'} /> Job aktiv (Zeitplan läuft)</label>
      <p class="error" id="modal-error"></p>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="job-cancel">Abbrechen</button>
        <button class="btn" type="submit" id="job-save">Speichern</button>
      </div>
    </form>`, (root) => {
    const form = $('#job-form', root);
    const known = new Map((job?.sources ?? []).map((s) => [s.id, s]));
    let candidates = [];

    const syncSchedule = () => {
      const mode = form.mode.value;
      $$('[data-sch]', form).forEach((l) => { l.style.display = l.dataset.sch.split(' ').includes(mode) ? '' : 'none'; });
    };
    form.mode.addEventListener('change', syncSchedule);
    syncSchedule();

    const renderSources = () => {
      // vorhandene Quellen des Jobs + neu erkannte (ohne Dopplung)
      const all = new Map();
      for (const s of known.values()) all.set(s.id, { ...s, suggested: s.enabled, available: true, reason: 'bereits im Job', existing: true });
      for (const c of candidates) if (!all.has(c.id)) all.set(c.id, { ...c, enabled: c.suggested });
      $('#sources', root).innerHTML = [...all.values()].map((c) => `
        <label class="checkbox-row" title="${esc(c.config?.path || c.config?.url_secret || '')}">
          <input type="checkbox" data-src="${esc(c.id)}" ${c.enabled && c.available ? 'checked' : ''} ${c.available ? '' : 'disabled'} />
          <span><strong>${esc(c.label)}</strong> <span class="muted">– ${esc(c.reason)}</span>${c.available ? '' : `<br><span class="error">${esc(c.missing || 'nicht verfügbar')}</span>`}</span>
        </label>`).join('') || '<p class="muted">Nichts erkannt.</p>';
      root._sources = all;
    };

    const detect = async () => {
      $('#detect-state', root).textContent = 'Erkenne … (kann bis zu 15 Sekunden dauern)';
      try {
        const res = await post(`/api/projects/${project.id}/backup-jobs/detect`, { machine_id: form.machine_id.value });
        candidates = res.candidates;
        renderSources();
        $('#detect-state', root).textContent = res.candidates.length ? 'Erkannt – Auswahl anpassen:' : 'Nichts automatisch erkannt.';
        $('#notes', root).innerHTML = res.notes.map((n) => `<p>${esc(n)}</p>`).join('');
        $('#found-dirs', root).innerHTML = res.backup_dirs.map((d) => `
          <p class="alert info">Vorhandene Backups erkannt: <span class="mono">${esc(d.path)}</span> (${d.bundles}, neuestes ${esc(fmtDate(d.newest))})
            <button class="btn ghost sm" type="button" data-use-dir="${esc(d.path)}">Diesen Ordner verwenden</button></p>`).join('');
        $$('[data-use-dir]', root).forEach((b) => b.addEventListener('click', () => { form.target_dir.value = b.dataset.useDir; }));
        if (!form.target_dir.value) {
          const m = machines.find((x) => x.id === form.machine_id.value);
          if (m?.suggested_dir) form.target_dir.value = m.suggested_dir;
        }
      } catch (err) {
        $('#detect-state', root).textContent = `Erkennung fehlgeschlagen: ${err.message}`;
        renderSources();
      }
    };
    $('#btn-detect', root).addEventListener('click', detect);
    form.machine_id.addEventListener('change', () => {
      const m = machines.find((x) => x.id === form.machine_id.value);
      if (m?.suggested_dir && !job) form.target_dir.value = m.suggested_dir;
      detect();
    });
    if (!job) { const m = machines.find((x) => x.id === preferred); if (m?.suggested_dir) form.target_dir.value = m.suggested_dir; }
    renderSources();
    detect();

    $('#job-cancel', root).addEventListener('click', closeModal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sources = [...(root._sources?.values() ?? [])].map((c) => {
        const box = $(`[data-src="${CSS.escape(c.id)}"]`, root);
        return { id: c.id, kind: c.kind, label: c.label, config: c.config, enabled: Boolean(box?.checked) };
      }).filter((s) => s.enabled || known.has(s.id));
      const body = {
        name: form.name.value,
        machine_id: form.machine_id.value,
        target_dir: form.target_dir.value.trim(),
        sources,
        schedule: { mode: form.mode.value, time: form.time.value || '03:00', weekday: Number(form.weekday.value), every_hours: Number(form.every_hours.value) },
        retention: { keep_days: Number(form.keep_days.value), keep_min: Number(form.keep_min.value) },
        enabled: form.enabled.checked,
      };
      $('#job-save', root).disabled = true;
      try {
        if (job) await patch(`/api/projects/${project.id}/backup-jobs/${job.id}`, body);
        else await post(`/api/projects/${project.id}/backup-jobs`, body);
        closeModal();
        toast(job ? 'Job gespeichert' : 'Backup eingerichtet – vorhandene Backups werden eingelesen', 'success');
        onDone();
        if (!job) setTimeout(onDone, 5000);
      } catch (err) {
        setModalError(root, err.message);
        $('#job-save', root).disabled = false;
      }
    });
  });
}
