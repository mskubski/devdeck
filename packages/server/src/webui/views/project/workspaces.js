import { get, post, patch, del } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, setModalError, confirmModal, closeModal, openModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';
import { ENV_HELP_HTML } from '../../lib/envHelp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wartet auf das Ergebnis eines Agent-Auftrags (Long-Poll beim Agenten, daher bis zu ~90 s). */
async function waitForCommand(workspaceId, commandId) {
  for (let i = 0; i < 45; i += 1) {
    await sleep(2000);
    const c = await get(`/api/workspaces/${workspaceId}/commands/${commandId}`);
    if (c.status === 'done') return c.result;
    if (c.status === 'failed' || c.status === 'expired') throw new Error(c.error || 'Auftrag fehlgeschlagen');
  }
  throw new Error('Der Agent hat nicht rechtzeitig geantwortet – ist die Maschine online?');
}

const ACTION_LABEL = { new: 'neu', existing: 'vorhanden – wird übersprungen', overwrite: 'wird überschrieben' };

function previewHtml(r) {
  const secrets = r.secrets.items.map((s) =>
    `<tr><td class="mono">${esc(s.name)}</td><td>${esc(s.environment)}</td><td class="muted text-sm">${esc(ACTION_LABEL[s.action])}</td></tr>`).join('');
  return `
    <p class="text-sm muted">Gefundene Dateien: ${r.files.length ? r.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(', ') : 'keine'}</p>
    <ul class="text-sm">
      <li><strong>Changelog:</strong> ${r.changelog.new} neu, ${r.changelog.existing} bereits vorhanden
        ${r.samples?.changelog?.length ? `<br><span class="muted">z. B. ${r.samples.changelog.map(esc).join(' · ')}</span>` : ''}</li>
      <li><strong>Tasks:</strong> ${r.tasks.new} neu (davon ${r.tasks.new_done} erledigt), ${r.tasks.existing} bereits vorhanden
        ${r.samples?.tasks?.length ? `<br><span class="muted">z. B. ${r.samples.tasks.map((t) => `${t.done ? '✓ ' : ''}${esc(t.title)}`).join(' · ')}</span>` : ''}</li>
      <li><strong>Secrets:</strong> ${r.secrets.new} neu, ${r.secrets.existing} bereits vorhanden${r.duplicates ? ` – ${r.duplicates} doppelte Namen aus mehreren Dateien zusammengefasst (<span class="mono">.env</span> hat Vorrang vor <span class="mono">credentials.md</span>${r.conflicts ? `, bei ${r.conflicts} mit unterschiedlichem Wert` : ''})` : ''}</li>
    </ul>
    ${(!r.changelog.total || !r.tasks.total) && r.files_seen?.length ? `<p class="text-sm muted">${!r.changelog.total ? 'Kein Changelog erkannt. ' : ''}${!r.tasks.total ? 'Keine Tasks erkannt. ' : ''}Textdateien im Workspace: ${r.files_seen.map((f) => `<span class="mono">${esc(f)}</span>`).join(', ')}. Erkannt werden Dateien namens CHANGELOG/HISTORY (Changelog) und ROADMAP/TODO (Tasks), auch in <span class="mono">docs/</span>.</p>` : ''}
    ${r.secrets.items.length ? `<div class="table-wrap"><table><thead><tr><th>Secret</th><th>Umgebung</th><th>Aktion</th></tr></thead><tbody>${secrets}</tbody></table></div>
      <p class="text-sm muted">Werte werden verschlüsselt im Vault gespeichert und hier nie angezeigt. Die Quelldateien enthalten sie weiterhin im Klartext – danach <span class="mono">credentials.md</span> löschen bzw. <span class="mono">.env</span> nicht committen.</p>` : ''}`;
}

/** Import-Ablauf: Vorschau (Agent liest die Dateien lokal) → Bestätigung → Import. */
async function runImportFlow(wsId, onDone) {
  const form = await formModal({
    title: 'Aus Workspace importieren',
    submitLabel: 'Vorschau erstellen',
    bodyHtml: `
      <p class="text-sm muted">Der Agent liest CHANGELOG.md, ROADMAP.md/TODO.md sowie .env und credentials.md im Workspace und zeigt zuerst eine Vorschau. Es wird noch nichts importiert.</p>
      <label>Umgebung für Secrets
        <select name="environment">
          <option value="production" selected>production (Live-Betrieb)</option>
          <option value="staging">staging (Probelauf)</option>
          <option value="development">development (Entwicklung)</option>
        </select>
      </label>
      ${ENV_HELP_HTML}
      <p class="text-sm muted"><strong>Empfehlung:</strong> Läuft die Software auf dieser Maschine produktiv (z. B. helferle), sind die Werte
        in der <span class="mono">.env</span> die Live-Werte → <em>production</em>. Sie liegen dann sicher im Vault; DevDeck schreibt sie beim Sync nicht
        zurück in die <span class="mono">.env</span> (das gilt nur für <em>development</em>). Dateien wie <span class="mono">.env.staging</span> gehen automatisch in die passende Umgebung.</p>
      <label class="row" style="gap:var(--space-2)"><input type="checkbox" name="overwrite" style="width:auto" /> Vorhandene Secrets überschreiben</label>`,
  });
  if (!form) return;
  const environment = form.data.environment;
  const overwrite = form.data.overwrite === 'on';
  closeModal();
  try {
    toast('Vorschau wird erstellt …', 'info');
    const { command_id } = await post(`/api/workspaces/${wsId}/import`, { dry_run: true, environment, overwrite });
    const preview = await waitForCommand(wsId, command_id);
    const nothing = !preview.changelog.new && !preview.tasks.new && !preview.secrets.items.some((s) => s.action !== 'existing');
    openModal(`
      <h2>Import-Vorschau</h2>
      ${previewHtml(preview)}
      <div class="modal-actions">
        <button class="btn ghost" id="imp-cancel" type="button">${nothing ? 'Schließen' : 'Abbrechen'}</button>
        ${nothing ? '' : '<button class="btn" id="imp-go" type="button">Jetzt importieren</button>'}
      </div>`, (root) => {
      $('#imp-cancel', root).addEventListener('click', closeModal);
      $('#imp-go', root)?.addEventListener('click', async () => {
        $('#imp-go', root).disabled = true;
        try {
          const { command_id: applyId } = await post(`/api/workspaces/${wsId}/import`, { dry_run: false, environment, overwrite });
          await waitForCommand(wsId, applyId);
          closeModal();
          toast('Import abgeschlossen', 'success');
          onDone();
        } catch (err) { closeModal(); toast(err.message, 'error'); }
      });
    });
  } catch (err) { toast(err.message, 'error'); }
}

const STATUS_EXPLAIN = {
  ready: 'alles in Ordnung',
  warning: 'läuft, aber es gibt Hinweise',
  blocked: 'eine Voraussetzung fehlt (z. B. Ordner, Git, Abhängigkeiten)',
  unknown: 'noch nicht geprüft',
  provisioning: 'wird gerade eingerichtet',
  offline: 'Maschine nicht erreichbar',
};
const CHECK_ICON = { OK: '✓', WARNING: '!', BLOCKED: '✗' };

/** Warum steht der Workspace auf diesem Status? Zeigt alle Prüfpunkte und den Git-Zustand. */
function showStatusDetails(w, machineName) {
  const r = w.readiness;
  const g = w.git_state;
  const checks = r?.checks?.length
    ? r.checks.map((c) => `
      <tr>
        <td><span class="badge ${c.status === 'OK' ? 'ok' : c.status === 'WARNING' ? 'warn' : 'bad'}">${CHECK_ICON[c.status] ?? ''} ${esc(c.status)}</span></td>
        <td>${esc(c.name)}</td>
        <td class="muted text-sm">${esc(c.detail || '')}</td>
      </tr>`).join('')
    : '';
  openModal(`
    <h2>Status: ${esc(w.status)}</h2>
    <p class="text-sm muted"><span class="mono">${esc(w.local_path)}</span>${machineName ? ` auf ${esc(machineName)}` : ''}<br>
      ${esc(STATUS_EXPLAIN[w.status] ?? '')}${w.checked_at ? ` · zuletzt geprüft ${fmtDate(w.checked_at)}` : ''}</p>
    ${checks ? `<div class="table-wrap"><table><thead><tr><th>Ergebnis</th><th>Prüfpunkt</th><th>Hinweis</th></tr></thead><tbody>${checks}</tbody></table></div>`
      : '<p class="text-sm">Noch keine Prüfung vorhanden. Mit „Prüfen“ wird der Workspace gelesen (ohne zu synchronisieren).</p>'}
    ${g ? `<p class="text-sm muted">Git: Branch <span class="mono">${esc(g.branch ?? '–')}</span>
      · ${g.dirty ? `<strong>${g.files?.length ?? '?'} lokale Änderung(en)</strong>` : 'keine lokalen Änderungen'}
      · ${g.ahead ? `${g.ahead} nicht gepusht` : 'nichts zu pushen'} · ${g.behind ? `${g.behind} neu auf dem Remote` : 'aktuell'}
      ${g.message ? `<br>Letzter Commit: ${esc(g.message)}` : ''}</p>` : ''}
    <p class="text-sm muted">Bedeutung: <strong>ready</strong> = alles in Ordnung · <strong>warning</strong> = läuft, aber es gibt Hinweise ·
      <strong>blocked</strong> = eine Voraussetzung fehlt · <strong>unknown</strong> = noch nicht geprüft.</p>
    <div class="modal-actions"><button class="btn" id="st-close" type="button">Schließen</button></div>`,
  (root) => $('#st-close', root).addEventListener('click', closeModal));
}

const sepOf = (m) => (m?.platform === 'win32' ? '\\' : '/');

/**
 * Formular zum Registrieren/Bearbeiten eines Workspaces. Zeigt den Workspace-Root der gewählten Maschine
 * (der Pfad muss darunter liegen) und füllt ihn als Vorschlag ein.
 */
function workspaceForm({ title, submitLabel, machines, initial = {} }) {
  return new Promise((resolve) => {
    const machineOptions = machines.map((m) =>
      `<option value="${esc(m.id)}" ${m.id === initial.machine_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    openModal(`
      <h2>${esc(title)}</h2>
      <form id="modal-form" class="stack">
        <label>Maschine
          <select name="machine_id"><option value="">– später zuordnen –</option>${machineOptions}</select>
        </label>
        <p class="text-sm muted" id="root-hint"></p>
        <label>Lokaler Pfad <input name="local_path" required value="${esc(initial.local_path ?? '')}" /></label>
        <label>Branch <input name="branch" value="${esc(initial.branch ?? '')}" placeholder="main" /></label>
        <label>Repository (optional – sonst das des Projekts) <input name="repo_remote" value="${esc(initial.repo_remote ?? '')}" placeholder="https://github.com/…" /></label>
        <p class="error" id="modal-error"></p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" id="modal-cancel">Abbrechen</button>
          <button class="btn" type="submit">${esc(submitLabel)}</button>
        </div>
      </form>`, (root) => {
      const form = $('#modal-form', root);
      const select = form.elements.machine_id;
      const pathInput = form.elements.local_path;
      let lastSuggestion = '';
      const refreshHint = () => {
        const m = machines.find((x) => x.id === select.value);
        const hint = $('#root-hint', root);
        if (!m) { hint.textContent = 'Ohne Maschine wird der Pfad erst beim Zuordnen geprüft.'; return; }
        if (!m.workspace_root) { hint.textContent = `Für „${m.name}“ ist noch kein Workspace-Root bekannt.`; return; }
        hint.innerHTML = `Der Pfad muss unterhalb des Workspace-Roots von „${esc(m.name)}“ liegen: <span class="mono">${esc(m.workspace_root)}</span>`;
        const suggestion = m.workspace_root.replace(/[\\/]+$/, '') + sepOf(m);
        if (!pathInput.value || pathInput.value === lastSuggestion) { pathInput.value = suggestion; lastSuggestion = suggestion; }
      };
      select.addEventListener('change', refreshHint);
      refreshHint();
      $('#modal-cancel', root).addEventListener('click', () => { closeModal(); resolve(null); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        resolve({ data: Object.fromEntries(new FormData(form)), root });
      });
    });
  });
}

export async function renderWorkspaces(el, project) {
  const [workspaces, machines] = await Promise.all([
    get(`/api/projects/${project.id}/workspaces`),
    get(`/api/machines?project_id=${project.id}`).catch(() => []),
  ]);
  const canManage = roleAtLeast(project.role, 'developer');
  const machineName = new Map(machines.map((m) => [m.id, m.name]));

  const rows = workspaces.map((w) => `
    <tr>
      <td><span class="mono text-sm">${esc(w.local_path)}</span></td>
      <td class="muted text-sm">${esc(w.machine_id ? (machineName.get(w.machine_id) || w.machine_id) : '–')}</td>
      <td class="muted text-sm">${esc(w.branch || '–')}</td>
      <td><button class="btn ghost sm" data-status="${w.id}" title="${esc(STATUS_EXPLAIN[w.status] ?? '')} – Klick für Details">${badge(w.status, w.status)}</button></td>
      <td class="muted text-sm">${w.last_sync_at ? fmtDate(w.last_sync_at) : 'nie'}</td>
      <td class="actions">
        ${canManage ? `
          <button class="btn ghost sm" data-check="${w.id}" title="Nur prüfen (Git-Zustand, Voraussetzungen) – ändert nichts">Prüfen</button>
          <button class="btn ghost sm" data-sync="${w.id}">Sync</button>
          ${roleAtLeast(project.role, 'maintainer') ? `<button class="btn ghost sm" data-import="${w.id}">Importieren</button>` : ''}
          <button class="btn ghost sm" data-provision="${w.id}">Provision</button>
          ${roleAtLeast(project.role, 'maintainer') ? `<button class="btn ghost sm" data-deploy="${w.id}" data-path="${esc(w.local_path)}" title="Neuesten Stand holen und die Dienste dieses Workspaces neu starten">Deploy</button>` : ''}
          <button class="btn ghost sm" data-edit="${w.id}">Bearbeiten</button>
          ${roleAtLeast(project.role, 'maintainer') ? `<button class="btn ghost sm" data-delete="${w.id}" data-path="${esc(w.local_path)}">Entfernen</button>` : ''}` : ''}
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="alert info">${icon('info')}<span>Sync/Provision werden als Kommando an den DevDeck Agent der zugeordneten Maschine zugestellt (Long-Poll). Die Maschine muss online sein.</span></div>
    <div class="card">
      <div class="card-head">
        <h2>Workspaces</h2>
        ${canManage ? '<button class="btn sm" id="btn-new-workspace">' + icon('plus') + 'Workspace registrieren</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Pfad</th><th>Maschine</th><th>Branch</th><th>Status</th><th>Letzter Sync</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty-state"><div class="icon">' + icon('laptop', { size: 32 }) + '</div>Noch keine Workspaces registriert.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-workspace', el)?.addEventListener('click', async () => {
    const res = await workspaceForm({ title: 'Workspace registrieren', submitLabel: 'Registrieren', machines });
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/workspaces`, {
        ...res.data,
        machine_id: res.data.machine_id || undefined,
      });
      closeModal();
      toast('Workspace registriert', 'success');
      renderWorkspaces(el, project);
    } catch (err) { setModalError(res.root, err.message); }
  });

  for (const btn of $$('[data-status]', el)) {
    btn.addEventListener('click', () => {
      const w = workspaces.find((x) => x.id === btn.dataset.status);
      showStatusDetails(w, w.machine_id ? machineName.get(w.machine_id) : null);
    });
  }
  for (const btn of $$('[data-check]', el)) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const { command_id } = await post(`/api/workspaces/${btn.dataset.check}/check`);
        toast('Prüfung läuft …', 'info');
        await waitForCommand(btn.dataset.check, command_id);
        renderWorkspaces(el, project);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  }
  for (const btn of $$('[data-edit]', el)) {
    btn.addEventListener('click', async () => {
      const w = workspaces.find((x) => x.id === btn.dataset.edit);
      const res = await workspaceForm({ title: 'Workspace bearbeiten', submitLabel: 'Speichern', machines, initial: w });
      if (!res) return;
      try {
        await patch(`/api/workspaces/${w.id}`, { ...res.data, machine_id: res.data.machine_id || undefined });
        closeModal();
        toast('Workspace gespeichert', 'success');
        renderWorkspaces(el, project);
      } catch (err) { setModalError(res.root, err.message); }
    });
  }
  for (const btn of $$('[data-delete]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Workspace entfernen',
        message: `„${btn.dataset.path}“ aus DevDeck entfernen? Es werden keine Dateien auf der Maschine gelöscht – nur die Registrierung (und wartende Aufträge dafür).`,
        confirmLabel: 'Entfernen',
      });
      if (!ok) return;
      try {
        await del(`/api/workspaces/${btn.dataset.delete}`, { confirm: true });
        toast('Workspace entfernt', 'success');
        renderWorkspaces(el, project);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  for (const btn of $$('[data-sync]', el)) {
    btn.addEventListener('click', async () => {
      try {
        await post(`/api/workspaces/${btn.dataset.sync}/sync`);
        toast('Sync beauftragt – Ergebnis siehe Tab „Sync-Log“', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  for (const btn of $$('[data-import]', el)) {
    btn.addEventListener('click', () => runImportFlow(btn.dataset.import, () => renderWorkspaces(el, project)));
  }
  for (const btn of $$('[data-deploy]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Deploy',
        message: `Holt den neuesten Stand von „${btn.dataset.path}“ (nur Fast-Forward) und startet die im Manifest (.devdeck/workspace.yaml, Block deploy) genannten Dienste neu. Sind sie danach nicht gesund, geht es automatisch auf den alten Stand zurück. Die Dienste sind kurz nicht erreichbar.`,
        confirmLabel: 'Deploy starten',
        danger: false,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        const { command_id } = await post(`/api/workspaces/${btn.dataset.deploy}/deploy`, { confirm: true });
        toast('Deploy läuft … (siehe auch Tab „Sync-Log“)', 'info');
        let result = null;
        for (let i = 0; i < 150; i += 1) {
          await sleep(2000);
          const c = await get(`/api/workspaces/${btn.dataset.deploy}/commands/${command_id}`);
          if (c.status === 'done') { result = c.result; break; }
          if (c.status === 'failed' || c.status === 'expired') throw new Error(c.error || 'Deploy fehlgeschlagen');
        }
        if (!result) throw new Error('Deploy dauert ungewöhnlich lange – Ergebnis siehe Tab „Sync-Log“');
        const steps = (result.steps || []).map((s) => `<li>${esc(s.step)}: ${esc(s.status)}${s.detail ? ` – ${esc(s.detail)}` : ''}</li>`).join('');
        openModal(`
          <h2>Deploy erfolgreich</h2>
          <p class="text-sm">${result.up_to_date ? 'Kein neuer Code – Dienste neu gestartet.' : `<span class="mono">${esc(result.from)}</span> → <span class="mono">${esc(result.to)}</span>`}</p>
          <ul class="text-sm">${steps}</ul>
          <div class="modal-actions"><button class="btn" id="btn-close-deploy" type="button">Schließen</button></div>`, (root) => {
          root.querySelector('#btn-close-deploy').addEventListener('click', closeModal);
        });
        renderWorkspaces(el, project);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  }
  for (const btn of $$('[data-provision]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Workspace provisionieren',
        message: 'Provisioniert den Workspace vollständig (Clone/Toolchain/Dependencies/Secrets/Context). Bei bereits vorhandenen, abweichenden Inhalten bricht der Agent sicherheitshalber ab.',
        confirmLabel: 'Provisionieren',
        danger: false,
      });
      if (!ok) return;
      try {
        await post(`/api/workspaces/${btn.dataset.provision}/provision`, { confirm: true });
        toast('Provisioning beauftragt – Ergebnis siehe Tab „Sync-Log“', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}
