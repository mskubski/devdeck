import { $, esc, badge, fmtDate, openModal, closeModal, setModalError } from './ui.js';
import { icon } from './icons.js';

/** Kurzer Zustand einer Replik (Badge + Zähler + letzte Meldung). */
export function replicaStatusHtml(r) {
  if (!r) return '<span class="muted text-sm">keine Replik</span>';
  const parts = [];
  if (!r.enabled) parts.push(badge('pausiert', 'warn'));
  else if (r.busy) parts.push(badge('kopiert …', 'warn'));
  else if (r.last_ok === true) parts.push(badge('synchron', 'ok'));
  else if (r.last_ok === false) parts.push(badge('Fehler', 'failed'));
  else parts.push(badge('wartet', 'queued'));
  parts.push(`<span class="text-sm">${r.replicated_count}/${r.primary_count} kopiert</span>`);
  const when = r.last_sync_at ? `<span class="muted text-sm">zuletzt ${esc(fmtDate(r.last_sync_at))}</span>` : '';
  const msg = r.message ? `<br><span class="${r.last_ok === false ? 'error' : 'muted'} text-sm">${esc(r.message)}</span>` : '';
  return `${parts.join(' ')} ${when}${msg}`;
}

/**
 * Dialog zum Einrichten/Ändern einer Replik: Ziel-Maschine wählen, Ordner (Vorschlag = bisheriger Pfad bzw. neuer Ordner neben dem Workspace-Root,
 * frei umbenennbar). `machines`: [{id,name,platform,agent_status,supported,suggested_dir,alternative_dir}].
 */
export function replicaModal({ title, intro, machines, current, onSave }) {
  const usable = machines.filter((m) => m.supported);
  const first = (current && machines.find((m) => m.id === current.machine?.id)) || usable[0] || machines[0];
  openModal(`
    <h2>${esc(title)}</h2>
    <p class="muted text-sm">${intro}</p>
    ${machines.length ? '' : '<div class="alert info"><span>Es ist keine weitere Maschine eingetragen. Unter „Maschinen“ lässt sich eine hinzufügen.</span></div>'}
    <form id="replica-form" class="stack">
      <label>Ziel-Maschine
        <select name="machine_id" id="rep-machine" required>
          ${machines.map((m) => `<option value="${esc(m.id)}" ${m.id === first?.id ? 'selected' : ''} ${m.supported ? '' : 'disabled'}>${esc(m.name)} (${esc(m.platform)}, ${esc(m.agent_status)}${m.supported ? '' : ' – Agent zu alt, bitte aktualisieren'})</option>`).join('')}
        </select>
      </label>
      <label>Ordner auf der Ziel-Maschine
        <input name="target_dir" id="rep-dir" required autocomplete="off" spellcheck="false" />
      </label>
      <p class="muted text-sm" id="rep-hint"></p>
      <label class="toggle"><input type="checkbox" role="switch" name="enabled" id="rep-enabled" ${current && !current.enabled ? '' : 'checked'}><span class="track"></span>Replikation aktiv</label>
      <p class="muted text-sm">Kopiert werden alle vorhandenen und künftigen Backups. Löscht die Aufbewahrung beim Primär-Backup ein Backup, wird es auch auf der Replik gelöscht (nur Backup-Ordner – andere Dateien im Ordner bleiben unangetastet).</p>
      <p class="error" id="modal-error"></p>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="rep-cancel">Abbrechen</button>
        <button class="btn" type="submit" id="rep-save" ${machines.length ? '' : 'disabled'}>${icon('check', { size: 16 })}<span>Speichern</span></button>
      </div>
    </form>`, (root) => {
    const select = $('#rep-machine', root);
    const dir = $('#rep-dir', root);
    const hint = $('#rep-hint', root);
    let edited = Boolean(current && first && current.machine?.id === first.id);
    if (edited) dir.value = current.target_dir;
    const apply = () => {
      const m = machines.find((x) => x.id === select.value);
      if (!m) return;
      if (!edited) dir.value = m.suggested_dir ?? '';
      hint.innerHTML = m.suggested_dir
        ? `Vorschlag: <span class="mono">${esc(m.suggested_dir)}</span> – der Ordner wird bei Bedarf angelegt und kann beliebig umbenannt werden.${m.alternative_dir ? ` Alternativ: <a href="#" id="rep-alt" class="link">${esc(m.alternative_dir)}</a>` : ''}`
        : 'Bitte einen absoluten Ordnerpfad auf dieser Maschine angeben (er wird bei Bedarf angelegt).';
      $('#rep-alt', root)?.addEventListener('click', (e) => { e.preventDefault(); dir.value = m.alternative_dir; edited = true; });
    };
    select.addEventListener('change', () => { edited = false; apply(); });
    dir.addEventListener('input', () => { edited = true; });
    apply();
    $('#rep-cancel', root).addEventListener('click', closeModal);
    $('#replica-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#rep-save', root);
      btn.disabled = true;
      try {
        await onSave({ machine_id: select.value, target_dir: dir.value.trim(), enabled: $('#rep-enabled', root).checked });
        closeModal();
      } catch (err) {
        setModalError(root, err.message);
        btn.disabled = false;
      }
    });
  });
}
