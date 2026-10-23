import { get, post } from '../lib/api.js';
import { $, esc, badge, toast, confirmModal } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stepsHtml(steps) {
  return steps.map((s) => `
    <div class="row between text-sm">
      <span>${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '…'} ${esc(s.name)}</span>
      <span class="muted">${esc(s.detail || '')}</span>
    </div>`).join('');
}

/** Wartet, bis der Server nach dem Neustart wieder antwortet, und lädt die Seite neu. */
async function waitForRestart(el) {
  $('#update-status', el).innerHTML += '<div class="text-sm muted">Server startet neu …</div>';
  let wasDown = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok && wasDown) { location.reload(); return; }
    } catch { wasDown = true; }
    if (i > 15 && !wasDown) { location.reload(); return; } // Neustart war schneller als unser Polling
  }
  toast('Server antwortet nicht – bitte Dienst auf dem Server prüfen', 'error');
}

export async function renderSystem(el, refresh = false) {
  const v = await get(`/api/system/version${refresh ? '?refresh=1' : ''}`);
  const upToDate = v.behind === 0 && !v.on_other_branch;
  let status;
  if (v.fetch_error) status = badge('GitHub nicht erreichbar', 'bad');
  else if (v.dirty) status = badge('lokale Änderungen im Server-Ordner', 'bad');
  else if (v.on_other_branch) status = badge(`auf Branch ${v.branch} – Update wechselt auf ${v.target_branch}`, 'warn');
  else if (v.behind > 0) status = badge(`${v.behind} Update${v.behind === 1 ? '' : 's'} verfügbar`, 'warn');
  else if (v.behind === 0) status = badge('aktuell', 'ok');
  else status = badge('unbekannt', '');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>System</h1>
        <p class="lede">Server auf den neuesten Stand von GitHub bringen. Vorher wird automatisch ein Backup erstellt; schlägt etwas fehl, bleibt der alte Stand aktiv.</p>
      </div>
    </div>
    <div class="card">
      <div class="stack text-sm">
        <div><span class="muted">Laufender Stand</span><br><span class="mono">${esc(v.commit)}</span> · ${esc(v.subject)}</div>
        <div><span class="muted">Branch</span><br><span class="mono">${esc(v.branch)}</span> (Ziel: <span class="mono">${esc(v.target_branch)}</span>)</div>
        <div>${status}</div>
        ${v.can_restart ? '' : '<div class="muted">Kein systemd erkannt: Nach dem Update muss der Server manuell neu gestartet werden.</div>'}
      </div>
      <div class="row" style="margin-top:var(--space-4);gap:var(--space-3)">
        <button class="btn" id="btn-update" ${v.dirty || v.fetch_error ? 'disabled' : ''}>${icon('check')}Server aktualisieren</button>
        <button class="btn ghost" id="btn-check">Nach Updates suchen</button>
      </div>
      <div id="update-status" class="stack" style="margin-top:var(--space-4)"></div>
    </div>`;

  $('#btn-check', el).addEventListener('click', () => renderSystem(el, true));
  $('#btn-update', el).addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Server aktualisieren',
      message: upToDate
        ? 'Der Server ist laut letztem Stand aktuell. Trotzdem prüfen und ggf. aktualisieren?'
        : 'Backup erstellen, neuesten Code von GitHub holen, bauen und den Server neu starten. Die Oberfläche ist dabei kurz nicht erreichbar.',
      confirmLabel: 'Aktualisieren',
      danger: false,
    });
    if (!ok) return;
    $('#btn-update', el).disabled = true;
    const box = $('#update-status', el);
    try {
      await post('/api/system/update');
      for (let i = 0; i < 600; i += 1) {
        await sleep(2000);
        let s;
        try { s = await get('/api/system/update'); } catch { await waitForRestart(el); return; }
        box.innerHTML = stepsHtml(s.steps);
        if (s.state === 'failed') {
          box.innerHTML += `<div class="error">${esc(s.error)}</div>`;
          toast('Update fehlgeschlagen – der vorherige Stand bleibt aktiv', 'error');
          return;
        }
        if (s.state === 'success') {
          if (s.restarting) { await waitForRestart(el); return; }
          toast(s.from === s.to ? 'Bereits auf dem neuesten Stand' : 'Aktualisiert – bitte Server manuell neu starten', 'success');
          return;
        }
      }
    } catch (err) { toast(err.message, 'error'); $('#btn-update', el).disabled = false; }
  });
}
