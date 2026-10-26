import { get, post } from './api.js';
import { $$, esc, toast } from './ui.js';

/** Schalter „Autostart“ für eine Maschine: der Agent wird beim Hochfahren/Anmelden automatisch gestartet. */
export function autostartSwitch(m, canEdit = true) {
  const known = m.autostart !== null && m.autostart !== undefined;
  const enabled = known && m.autostart.enabled;
  let disabled = '';
  let hint = known ? `Autostart: ${m.autostart.method}${m.autostart.detail ? ' – ' + m.autostart.detail : ''}` : 'Autostart-Zustand noch nicht gemeldet';
  if (!canEdit) { disabled = 'disabled'; hint = 'Nur Besitzer oder Admin dürfen den Autostart ändern'; }
  else if (m.agent_status !== 'online') { disabled = 'disabled'; hint = 'Maschine ist offline – Autostart lässt sich nur bei laufendem Agent ändern'; }
  else if (!m.agent_can_autostart) { disabled = 'disabled'; hint = 'Agent aktualisieren (ab Version 0.14.0 möglich)'; }
  return `<label class="inline-check" title="${esc(hint)}"><input type="checkbox" data-autostart="${esc(m.id)}" data-name="${esc(m.name)}" ${enabled ? 'checked' : ''} ${disabled}> Autostart${known ? '' : ' ?'}</label>`;
}

/** Schalter im Element aktivieren; nach der Rückmeldung des Agents wird `reload` aufgerufen. */
export function bindAutostart(root, reload) {
  for (const box of $$('[data-autostart]', root)) {
    box.addEventListener('change', async () => {
      const enabled = box.checked;
      box.disabled = true;
      try {
        const { command_id } = await post(`/api/machines/${box.dataset.autostart}/autostart`, { enabled });
        for (let i = 0; i < 40; i += 1) {
          await new Promise((r) => setTimeout(r, 1500));
          const cmd = await get(`/api/machines/${box.dataset.autostart}/commands/${command_id}`);
          if (cmd.status === 'done') { toast(`Autostart auf „${box.dataset.name}“ ${enabled ? 'eingeschaltet' : 'ausgeschaltet'}`, 'success'); reload(); return; }
          if (cmd.status === 'failed' || cmd.status === 'expired') throw new Error(cmd.error || 'Autostart konnte nicht geändert werden');
        }
        throw new Error('Agent hat noch nicht geantwortet – siehe Agent-Log');
      } catch (err) {
        toast(err.message, 'error');
        box.checked = !enabled;
        box.disabled = false;
      }
    });
  }
}
