import { get, post, put, state } from '../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, confirmModal, formModal, closeModal, setModalError } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { remoteHints, exposureNote } from '../lib/remoteHints.js';

/** Aktive Sitzung (eine pro Seite): wird beim Verlassen des Tabs getrennt. */
let active = null;

function disconnect() {
  if (!active) return;
  try { active.rfb.disconnect(); } catch { /* schon getrennt */ }
  active = null;
}

// Beim Wechsel zu einer anderen Seite oder einem anderen Tab die Sitzung beenden
window.addEventListener('hashchange', () => {
  if (active && !(location.hash.includes(`/machines/${active.machineId}`) && location.hash.includes('tab=remote'))) disconnect();
});

const rows = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v?.__html ?? esc(v)}</dd>`).join('')}</dl>`;
const html = (s) => ({ __html: s });

/** Befehl des Agents abwarten; liefert den Befehlsstatus oder wirft mit der Fehlermeldung. */
async function waitForCommand(machineId, commandId, { everyMs = 1000, maxMs = 60_000 } = {}) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, everyMs));
    const cmd = await get(`/api/machines/${machineId}/commands/${commandId}`);
    if (cmd.status === 'done') return cmd;
    if (cmd.status === 'failed' || cmd.status === 'expired') throw new Error(cmd.error || 'Der Agent hat den Auftrag nicht ausgeführt');
  }
  throw new Error('Der Agent hat noch nicht geantwortet – siehe Agent-Log');
}

function commandBlock(cmd) {
  return `<div class="cmd-row"><pre>${esc(cmd)}</pre><button class="btn ghost sm icon-only" type="button" data-copy="${esc(cmd)}" title="Befehl kopieren" aria-label="Befehl kopieren">${icon('copy', { size: 16 })}</button></div>`;
}

function hintsHtml(m, open) {
  const hints = remoteHints(m.platform, m.remote);
  return `<details class="rd-hints" ${open ? 'open' : ''}><summary>Manuell einrichten – passende Befehle</summary>
    <div class="stack" style="margin-top:var(--space-3)">${hints.map((h) => `
      <div><strong>${esc(h.title)}</strong>
        ${h.note ? `<p class="muted text-sm" style="margin:var(--space-1) 0 var(--space-2)">${esc(h.note)}</p>` : ''}
        ${(h.commands ?? []).map(commandBlock).join('')}
      </div>`).join('')}
    </div></details>`;
}

async function passwordDialog(m, reload) {
  const set = m.remote_password_set;
  const r = await formModal({
    title: 'VNC-Passwort hinterlegen',
    submitLabel: 'Speichern',
    bodyHtml: `
      <p class="muted text-sm">Das Passwort des VNC-Servers auf „${esc(m.name)}“. Es wird verschlüsselt im Vault abgelegt und nie angezeigt – DevDeck nutzt es nur, um beim Verbinden automatisch anzumelden.${set ? ' Ein Passwort ist bereits hinterlegt; ein neuer Wert ersetzt es.' : ''}</p>
      <label>Passwort <input type="password" name="password" autocomplete="new-password" maxlength="64" ${set ? '' : 'required'} placeholder="${set ? 'leer lassen = unverändert' : ''}"></label>
      ${set ? '<label class="toggle"><input type="checkbox" role="switch" name="clear" value="1"><span class="track"></span>Hinterlegtes Passwort entfernen</label>' : ''}`,
  });
  if (!r) return;
  try {
    if (r.data.clear) await put(`/api/machines/${m.id}/remote/password`, { password: null });
    else if (r.data.password) await put(`/api/machines/${m.id}/remote/password`, { password: r.data.password });
    else { closeModal(); return; }
    closeModal();
    toast(r.data.clear ? 'Passwort entfernt' : 'Passwort gespeichert', 'success');
    reload();
  } catch (err) {
    setModalError(r.root, err.message);
  }
}

async function installDialog(m, el, reload) {
  const ok = await confirmModal({
    title: 'VNC-Server einrichten',
    message: `Auf „${m.name}“ wird ${m.remote.install.method}. Der Agent erzeugt dafür ein zufälliges Passwort, das verschlüsselt im Vault landet. Das kann einige Minuten dauern. Der VNC-Server ist danach nur lokal erreichbar – der Zugriff läuft ausschließlich über DevDeck.`,
    confirmLabel: 'Einrichten',
    danger: false,
  });
  if (!ok) return;
  const box = $('#rd-progress', el);
  for (const b of $$('button', el)) b.disabled = true;
  box.innerHTML = `<div class="alert info"><span>${icon('hourglass', { size: 16 })} Der Agent richtet VNC ein … Das kann einige Minuten dauern. Du kannst diese Seite offen lassen.</span></div>`;
  try {
    const { command_id } = await post(`/api/machines/${m.id}/remote/install`, {});
    await waitForCommand(m.id, command_id, { everyMs: 3000, maxMs: 15 * 60_000 });
    toast('VNC-Server eingerichtet', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  reload();
}

async function recheck(m, reload, btn) {
  btn.disabled = true;
  try {
    const { command_id } = await post(`/api/machines/${m.id}/remote/detect`, {});
    await waitForCommand(m.id, command_id, { everyMs: 1000, maxMs: 60_000 });
    toast('Zustand aktualisiert', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  reload();
}

/** Verbindung aufbauen: Sitzung anlegen, Agent-Tunnel abwarten, dann noVNC mit dem WebSocket des Servers verbinden. */
async function connect(m, el) {
  const view = $('#rd-view', el);
  const status = $('#rd-status', el);
  const screen = $('#rd-screen', el);
  disconnect();
  view.hidden = false;
  screen.innerHTML = '';
  status.textContent = 'Verbinde …';
  $('#rd-connect', el).disabled = true;
  try {
    const s = await post(`/api/machines/${m.id}/remote/sessions`, {});
    status.textContent = 'Warte auf den Agent …';
    await waitForCommand(m.id, s.command_id, { everyMs: 600, maxMs: 40_000 });
    status.textContent = 'Lade Anzeige …';
    const { default: RFB } = await import('/vendor/novnc/core/rfb.js');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${s.ws_path}`;
    const rfb = new RFB(screen, url, { credentials: s.password ? { password: s.password } : undefined, wsProtocols: ['binary'] });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = '#000';
    active = { rfb, machineId: m.id };
    rfb.addEventListener('connect', () => { status.innerHTML = `${badge('Verbunden', 'ok')} <span class="muted text-sm">${esc(m.name)}</span>`; rfb.focus(); });
    rfb.addEventListener('disconnect', (e) => {
      if (active?.rfb === rfb) active = null;
      view.hidden = true;
      $('#rd-connect', el).disabled = false;
      toast(e.detail?.clean ? 'Verbindung beendet' : 'Verbindung getrennt', e.detail?.clean ? 'info' : 'error');
    });
    rfb.addEventListener('securityfailure', () => toast('Anmeldung am VNC-Server abgelehnt – Passwort prüfen („Passwort hinterlegen“)', 'error'));
    rfb.addEventListener('credentialsrequired', async () => {
      const r = await formModal({ title: 'VNC-Passwort', submitLabel: 'Anmelden', bodyHtml: `<p class="muted text-sm">Für „${esc(m.name)}“ ist kein Passwort hinterlegt. Hinterlege es über „Passwort“, dann entfällt diese Abfrage.</p><label>Passwort <input type="password" name="password" autocomplete="off" required autofocus></label>` });
      if (r) { closeModal(); rfb.sendCredentials({ password: r.data.password }); } else disconnect();
    });
    rfb.addEventListener('clipboard', (e) => { navigator.clipboard?.writeText(e.detail.text).catch(() => {}); });
    $('#rd-cad', el).onclick = () => rfb.sendCtrlAltDel();
    $('#rd-paste', el).onclick = async () => {
      try { rfb.clipboardPasteFrom(await navigator.clipboard.readText()); toast('Zwischenablage gesendet', 'success'); } catch { toast('Zwischenablage nicht lesbar (Browser-Berechtigung?)', 'error'); }
    };
    $('#rd-full', el).onclick = () => (document.fullscreenElement ? document.exitFullscreen() : screen.requestFullscreen?.());
    $('#rd-stop', el).onclick = () => disconnect();
  } catch (err) {
    view.hidden = true;
    $('#rd-connect', el).disabled = false;
    toast(err.message, 'error');
  }
}

/** Tab „Remote“: VNC-Zustand, Einrichtung und Bildschirm der Maschine im Browser (noVNC über den Agent-Tunnel). */
export function remoteTab(el, m, _inv, reload) {
  const canUse = m.owner_user_id === state.user.id || state.user.system_role === 'admin';
  const r = m.remote;
  const online = m.agent_status === 'online';
  let hint = '';
  if (!canUse) hint = 'Nur Besitzer oder Admin der Maschine dürfen den Fernzugriff nutzen.';
  else if (!online) hint = 'Die Maschine ist offline – Fernzugriff geht nur bei laufendem Agent.';
  else if (!m.agent_can_remote) hint = 'Der Agent muss mindestens Version 0.19.0 haben – bitte unter „Maschinen“ aktualisieren.';
  const usable = !hint;
  const running = Boolean(r?.vnc.running);
  const warn = exposureNote(r);

  const statusBadge = !r ? badge('Noch nicht geprüft', '') : running ? badge('VNC läuft', 'ok') : badge('Kein VNC-Server gefunden', 'warn');
  el.innerHTML = `
    <div class="stack">
      ${hint ? `<div class="alert info"><span>${icon('info', { size: 16 })} ${esc(hint)}</span></div>` : ''}
      ${warn ? `<div class="alert warn"><span>${icon('shield-alert', { size: 16 })} ${esc(warn)}</span></div>` : ''}
      <div id="rd-progress"></div>
      <div class="card">
        <div class="card-head"><h2>Fernzugriff (VNC)</h2>
          <div class="row" style="gap:var(--space-2);flex-wrap:wrap">
            ${usable ? `<button class="btn ghost sm" id="rd-check" type="button">${icon('refresh', { size: 16 })}<span>Neu prüfen</span></button>` : ''}
            ${usable ? `<button class="btn ghost sm" id="rd-pw" type="button">${icon('key', { size: 16 })}<span>Passwort</span></button>` : ''}
            ${usable && running ? `<button class="btn sm" id="rd-connect" type="button">${icon('monitor', { size: 16 })}<span>Verbinden</span></button>` : ''}
          </div>
        </div>
        ${rows([
          ['Status', html(statusBadge)],
          ['Port', r?.vnc.port ? String(r.vnc.port) : null],
          ['Software', r?.vnc.software],
          ['Erreichbarkeit', running ? html(r.vnc.local_only === true ? badge('Nur lokal (gut)', 'ok') : r.vnc.local_only === false ? badge('Auch im Netzwerk', 'warn') : '<span class="muted">unbekannt</span>') : null],
          ['Passwort', html(m.remote_password_set ? badge('Hinterlegt', 'ok') : '<span class="muted">nicht hinterlegt – wird beim Verbinden abgefragt</span>')],
          ['Zuletzt geprüft', r ? fmtDate(r.checked_at) : null],
        ])}
        ${r ? '' : '<p class="muted text-sm">Der Agent (ab Version 0.19.0) meldet den Zustand kurz nach dem Start und danach stündlich. Mit „Neu prüfen“ geht es sofort.</p>'}
      </div>
      <div class="card" id="rd-view" hidden>
        <div class="card-head"><div id="rd-status" class="row" style="gap:var(--space-2)"></div>
          <div class="row" style="gap:var(--space-2);flex-wrap:wrap">
            <button class="btn ghost sm" id="rd-cad" type="button" title="Strg+Alt+Entf senden">${icon('keyboard', { size: 16 })}<span>Strg+Alt+Entf</span></button>
            <button class="btn ghost sm" id="rd-paste" type="button" title="Text aus der Zwischenablage senden">${icon('clipboard', { size: 16 })}<span>Einfügen</span></button>
            <button class="btn ghost sm" id="rd-full" type="button" title="Vollbild">${icon('maximize', { size: 16 })}<span>Vollbild</span></button>
            <button class="btn danger sm" id="rd-stop" type="button">${icon('power', { size: 16 })}<span>Trennen</span></button>
          </div>
        </div>
        <div id="rd-screen" class="rd-screen"></div>
      </div>
      ${!running && r ? `<div class="card"><div class="card-head"><h2>VNC-Server einrichten</h2></div>
        ${r.install.possible && usable
          ? `<p class="text-sm" style="margin-top:0">DevDeck kann das für dich erledigen: ${esc(r.install.method)}. Das Passwort wird zufällig erzeugt und verschlüsselt im Vault abgelegt.</p>
             <button class="btn" id="rd-install" type="button">${icon('download', { size: 16 })}<span>Über den DevDeck-Agent einrichten</span></button>`
          : `<p class="text-sm" style="margin-top:0">${esc(r.install.reason || 'Hier muss VNC von Hand eingerichtet werden.')}</p>`}
        <div style="margin-top:var(--space-4)">${hintsHtml(m, !r.install.possible)}</div>
      </div>` : ''}
      ${running ? `<div class="card">${hintsHtml(m, false).replace('Manuell einrichten – passende Befehle', 'Anderen VNC-Server einrichten – Befehle')}</div>` : ''}
    </div>`;

  for (const b of $$('[data-copy]', el)) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Befehl kopiert', 'success'); } catch { toast('Kopieren nicht möglich', 'error'); }
    });
  }
  $('#rd-check', el)?.addEventListener('click', (e) => recheck(m, reload, e.currentTarget));
  $('#rd-pw', el)?.addEventListener('click', () => passwordDialog(m, reload));
  $('#rd-install', el)?.addEventListener('click', () => installDialog(m, el, reload));
  $('#rd-connect', el)?.addEventListener('click', () => connect(m, el));
}
