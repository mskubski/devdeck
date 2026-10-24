import { get, put, state } from '../lib/api.js';
import { $, $$, esc, badge, fmtDate, timeAgo, toast, formModal, closeModal, setModalError } from '../lib/ui.js';

const PLATFORM = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

const html = (s) => ({ __html: s });
const dt = (iso) => (iso ? fmtDate(iso) : null);
const gbText = (n) => (n >= 1000 ? `${(n / 1024).toFixed(2)} TB` : `${n.toFixed(n % 1 ? 1 : 0)} GB`);

/** Liste „Bezeichnung – Wert“; leere Werte werden weggelassen. */
function rows(pairs) {
  const items = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!items.length) return '<p class="muted text-sm">Keine Angaben.</p>';
  return `<dl class="kv">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v?.__html ?? esc(v)}</dd>`).join('')}</dl>`;
}

function diskBar(d) {
  const used = Math.max(0, d.total_gb - d.free_gb);
  const pct = d.total_gb > 0 ? Math.round((used / d.total_gb) * 100) : 0;
  const level = pct >= 95 ? 'bad' : pct >= 85 ? 'warn' : 'ok';
  const title = [d.name, d.label ? `(${d.label})` : ''].filter(Boolean).join(' ');
  return `<div class="disk">
    <div class="disk-head"><strong>${esc(title)}</strong><span class="muted text-sm">${gbText(d.free_gb)} frei von ${gbText(d.total_gb)}</span></div>
    <div class="disk-bar"><span class="disk-fill ${level}" style="width:${pct}%"></span></div>
  </div>`;
}

function mainTab(el, m, inv, reload) {
  const d = inv?.device ?? {};
  const o = inv?.os ?? {};
  const canEdit = m.owner_user_id === state.user.id || state.user.system_role === 'admin';
  const noInv = !inv
    ? `<div class="alert info"><span>Für diese Maschine liegt noch kein Inventar vor. Der Agent (ab Version 0.9.0) meldet es kurz nach dem Start und danach alle 15 Minuten.${m.agent_status === 'online' && m.agent_outdated ? ' Bitte den Agent aktualisieren.' : ''}</span></div>`
    : '';

  const security = (inv?.security ?? []).length
    ? `<dl class="kv">${inv.security.map((s) => `<dt>${esc(s.label)}</dt><dd>${s.level === 'unknown' ? `<span class="muted">${esc(s.value)}</span>` : `<span class="lvl ${esc(s.level)}">●</span> ${esc(s.value)}`}</dd>`).join('')}</dl>`
    : '<p class="muted text-sm">Keine Angaben.</p>';

  const fields = m.custom_fields ?? [];
  el.innerHTML = `
    ${noInv}
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><h2>Laufwerke</h2></div>
        ${(inv?.disks ?? []).length ? inv.disks.map(diskBar).join('') : '<p class="muted text-sm">Keine Angaben.</p>'}
      </div>
      <div class="card"><div class="card-head"><h2>Gerät</h2></div>
        ${rows([
          ['Computername', inv?.hostname],
          ['Hersteller', d.manufacturer],
          ['Modell', d.model],
          ['Version', d.version],
          ['Prozessor', d.processor],
          ['Seriennummer', d.serial],
          ['Arbeitsspeicher (RAM)', d.ram_gb ? `${d.ram_gb} GB` : null],
          ['BIOS', d.bios],
        ])}
      </div>
      <div class="card"><div class="card-head"><h2>Betriebssystem</h2></div>
        ${rows([
          ['System', o.name],
          ['Version', o.version],
          ['Build', o.build],
          ['Kernel', o.kernel],
          ['Architektur', o.arch],
          ['Sprache', o.language],
        ])}
      </div>
      <div class="card"><div class="card-head"><h2>Sicherheit</h2></div>${security}</div>
      <div class="card"><div class="card-head"><h2>Verwaltung (DevDeck)</h2></div>
        ${rows([
          ['Status', html(badge(m.agent_status, m.agent_status))],
          ['Zuletzt gesehen', m.last_seen_at ? `${timeAgo(m.last_seen_at)} (${fmtDate(m.last_seen_at)})` : 'nie'],
          ['Registriert', dt(m.created_at)],
          ['Agent-Version', html(`${esc(m.agent_version || '–')}${m.agent_outdated ? ' ' + badge('veraltet', 'warn') : ''}`)],
          ['Agent-Stand', [m.agent_commit, m.agent_node].filter(Boolean).join(' · ') || null],
          ['Workspace-Root', html(m.workspace_root ? `<span class="mono">${esc(m.workspace_root)}</span>` : '–')],
          ['Lokale IP-Adresse', (inv?.network?.ips ?? []).join(', ') || null],
          ['Startzeit', dt(inv?.runtime?.boot_time)],
          ['Inventar vom', dt(m.inventory_at)],
        ])}
      </div>
      <div class="card"><div class="card-head"><h2>Eigene Felder</h2>${canEdit ? '<button class="btn ghost sm" id="btn-edit-fields">Bearbeiten</button>' : ''}</div>
        ${fields.length ? rows(fields.map((f) => [f.label, f.value || '–'])) : `<p class="muted text-sm">Noch keine eigenen Felder.${canEdit ? ' Mit „Bearbeiten“ lassen sich beliebige Angaben ergänzen (z. B. Standort, Zuständiger, Kaufdatum).' : ''}</p>`}
      </div>
    </div>`;

  $('#btn-edit-fields', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Eigene Felder',
      submitLabel: 'Speichern',
      bodyHtml: `
        <label>Ein Feld pro Zeile im Format „Bezeichnung: Wert“
          <textarea name="fields" rows="10" placeholder="Standort: Laden&#10;Zuständig: Maurice">${esc(fields.map((f) => `${f.label}: ${f.value}`).join('\n'))}</textarea>
        </label>
        <span class="muted text-sm">Höchstens 30 Felder, Bezeichnung bis 60, Wert bis 500 Zeichen. Bitte keine Passwörter eintragen – dafür gibt es den Vault.</span>`,
    });
    if (!res) return;
    const parsed = res.data.fields.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      return i < 0 ? { label: line, value: '' } : { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    });
    try {
      await put(`/api/machines/${m.id}/custom-fields`, { fields: parsed });
      closeModal();
      toast('Felder gespeichert', 'success');
      reload();
    } catch (err) { setModalError(res.root, err.message); }
  });
}

/** Weitere Tabs (Einstellungen, Anwendungen, Patches, Inventar, …) kommen hier später dazu. */
const TABS = [{ key: 'main', label: 'Übersicht', render: mainTab }];

export async function renderMachineDetail(el, idAndQuery, setBreadcrumb) {
  const [id, qs] = idAndQuery.split('?');
  const activeKey = new URLSearchParams(qs ?? '').get('tab') || 'main';
  const m = await get(`/api/machines/${id}`);
  const inv = m.inventory;
  setBreadcrumb?.(m.name, 'Maschinen', '#/machines');

  const device = [inv?.device?.manufacturer, inv?.device?.model].filter(Boolean).join(' ');
  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(m.name)} ${badge(m.agent_status, m.agent_status)}</h1>
        <p class="lede">${esc(PLATFORM[m.platform] || m.platform)}${device ? ` · ${esc(device)}` : ''}</p>
      </div>
      <div class="page-actions"><a class="btn ghost sm" href="#/machines">Zurück zur Liste</a></div>
    </div>
    <div class="card machine-summary">
      <div><span class="muted text-sm">Benutzer</span><div>${esc(inv?.user || '–')}</div></div>
      <div><span class="muted text-sm">Gerät</span><div>${esc(device || '–')}</div></div>
      <div><span class="muted text-sm">Software</span><div>${esc(inv?.os?.name || PLATFORM[m.platform] || '–')}</div></div>
      <div><span class="muted text-sm">Seriennummer</span><div>${esc(inv?.device?.serial || '–')}</div></div>
      <div><span class="muted text-sm">Zuletzt gemeldet</span><div>${m.last_seen_at ? esc(timeAgo(m.last_seen_at)) : 'nie'}</div></div>
    </div>
    <div class="tabs" id="machine-tabs">
      ${TABS.map((t) => `<button class="tab ${t.key === activeKey ? 'active' : ''}" data-tab="${t.key}">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="machine-tab-body"></div>`;

  const active = TABS.find((t) => t.key === activeKey) ?? TABS[0];
  active.render($('#machine-tab-body', el), m, inv, () => renderMachineDetail(el, idAndQuery, setBreadcrumb));
  for (const btn of $$('[data-tab]', el)) {
    btn.addEventListener('click', () => { location.hash = `#/machines/${id}?tab=${btn.dataset.tab}`; });
  }
}
