import { get, del } from './api.js';
import { $, esc, openModal, closeModal, setModalError, toast } from './ui.js';
import { icon } from './icons.js';

const LABELS = [
  ['members', 'Mitglieder'], ['workspaces', 'Workspaces'], ['tasks', 'Tasks'], ['decisions', 'Entscheidungen'], ['changelog', 'Changelog-Einträge'],
  ['sessions', 'Coding Sessions'], ['secrets', 'Secrets'], ['connectors', 'Integrationen'], ['backup_jobs', 'Backup-Jobs'], ['backups', 'Backup-Einträge'],
];

const countsHtml = (c) => LABELS.filter(([k]) => c[k] > 0).map(([k, l]) => `<span class="badge">${esc(l)}: ${c[k]}</span>`).join(' ') || '<span class="muted">keine</span>';

/**
 * Dialog „Projekt löschen“: entweder nur das Projekt (die Daten in DevDeck bleiben, ein Admin kann es wiederherstellen)
 * oder mit allen Daten (endgültig, nur nach Eingabe des Projektnamens). Dateien auf den Maschinen bleiben in beiden Fällen unberührt.
 * `onDone` wird nach erfolgreichem Löschen aufgerufen.
 */
export async function projectDeleteModal(project, onDone) {
  let preview;
  try {
    preview = await get(`/api/projects/${project.id}/delete-preview`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  openModal(`
    <h2>${icon('trash', { size: 20 })} Projekt „${esc(project.name)}“ löschen</h2>
    <p class="muted text-sm">Dateien auf den Maschinen (Workspace-Ordner, Backup-Ordner und Repliken) werden in keinem Fall angefasst.</p>
    <div class="stack">
      <label class="choice"><input type="radio" name="mode" value="keep" checked />
        <span><strong>Nur das Projekt löschen – Daten bleiben erhalten</strong><br>
        <span class="muted text-sm">Das Projekt verschwindet aus allen Listen und ruht (keine Backups, Syncs und Prüfungen mehr). Seine Daten in DevDeck bleiben gespeichert; ein Administrator kann es unter „Projekte → Gelöschte Projekte“ wiederherstellen. Der Name wird wieder frei.</span></span></label>
      <label class="choice"><input type="radio" name="mode" value="purge" />
        <span><strong>Projekt mit allen Daten löschen</strong><br>
        <span class="muted text-sm">Endgültig und nicht rückgängig zu machen: Alles, was in DevDeck am Projekt hängt, wird gelöscht – inklusive der Secret-Werte im Vault.</span></span></label>
    </div>
    <div class="alert info" style="margin-top:var(--space-3)"><span><strong>Das hängt am Projekt:</strong> ${countsHtml(preview.counts)}</span></div>
    <div id="purge-box" class="hidden">
      <div class="alert danger"><span><strong>Achtung:</strong> Das Löschen mit Daten lässt sich nicht rückgängig machen. Tasks, Entscheidungen, Changelog, Sessions, Secrets und Backup-Einträge in DevDeck sind danach weg.</span></div>
      <label>Zur Bestätigung den Projektnamen <strong class="mono">${esc(project.name)}</strong> eintippen
        <input id="del-confirm" autocomplete="off" spellcheck="false" placeholder="${esc(project.name)}" />
      </label>
    </div>
    <p class="error" id="modal-error"></p>
    <div class="modal-actions">
      <button class="btn ghost" id="del-cancel" type="button">Abbrechen</button>
      <button class="btn danger" id="del-go" type="button">${icon('trash', { size: 16 })}<span>Projekt löschen</span></button>
    </div>`, (root) => {
    const go = $('#del-go', root);
    const input = $('#del-confirm', root);
    const mode = () => root.querySelector('input[name=mode]:checked').value;
    const sync = () => {
      const purge = mode() === 'purge';
      $('#purge-box', root).classList.toggle('hidden', !purge);
      go.querySelector('span').textContent = purge ? 'Endgültig löschen' : 'Projekt löschen';
      go.disabled = purge && input.value !== project.name;
    };
    for (const r of root.querySelectorAll('input[name=mode]')) r.addEventListener('change', sync);
    input.addEventListener('input', sync);
    $('#del-cancel', root).addEventListener('click', closeModal);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await del(`/api/projects/${project.id}`, mode() === 'purge' ? { mode: 'purge', confirm_name: input.value } : { mode: 'keep', confirm: true });
        closeModal();
        toast(mode() === 'purge' ? `Projekt „${project.name}“ mit allen Daten gelöscht` : `Projekt „${project.name}“ gelöscht – die Daten bleiben erhalten`, 'success');
        onDone();
      } catch (err) {
        setModalError(root, err.message);
        sync();
      }
    });
    sync();
  });
}
