import { get, post, put, state } from '../lib/api.js';
import { autostartSwitch, bindAutostart } from '../lib/autostart.js';
import { $, $$, esc, badge, fmtDate, timeAgo, toast, formModal, confirmModal, closeModal, setModalError } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

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

/** Sicherheitsliste: farbiger Punkt je Bewertung; „info“ ohne Bewertung, „unknown“ grau. */
function securityList(items) {
  if (!(items ?? []).length) return '<p class="muted text-sm">Keine Angaben.</p>';
  const value = (s) => (s.level === 'unknown' ? `<span class="muted">${esc(s.value)}</span>`
    : s.level === 'info' ? esc(s.value) : `<span class="lvl ${esc(s.level)}">●</span> ${esc(s.value)}`);
  return `<dl class="kv">${items.map((s) => `<dt>${esc(s.label)}</dt><dd>${value(s)}</dd>`).join('')}</dl>`;
}

function table(head, bodyRows) {
  if (!bodyRows.length) return '<p class="muted text-sm">Keine Angaben.</p>';
  return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c?.__html ?? esc(c ?? '–')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
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

  const security = securityList(inv?.security);

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
          ['Autostart', html(autostartSwitch(m, state.user.system_role === 'admin' || m.owner_user_id === state.user.id) + (m.autostart?.method ? ` <span class="muted text-sm">${esc(m.autostart.method)}</span>` : '') + (m.autostart?.detail ? `<br><span class="muted text-sm">${esc(m.autostart.detail)}</span>` : ''))],
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

  bindAutostart(el, reload);

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

/** Tab „Inventar“: Hardware- und Systemdetails, je Abschnitt mit Zeitstempel der letzten Erfassung. */
function inventoryTab(el, m, inv) {
  if (!inv) {
    el.innerHTML = '<div class="alert info"><span>Für diese Maschine liegt noch kein Inventar vor. Der Agent (ab Version 0.10.0) meldet es kurz nach dem Start und danach alle 15 Minuten.</span></div>';
    return;
  }
  const updated = `<span class="muted text-sm">Aktualisiert: ${esc(fmtDate(m.inventory_at || inv.collected_at))}</span>`;
  const section = (title, body) => `<div class="card"><div class="card-head"><h2>${esc(title)}</h2>${updated}</div>${body}</div>`;
  const d = inv.device ?? {};
  const c = inv.cpu;
  const b = inv.bios_info;
  const olderAgent = !inv.cpu && !inv.bios_info && !(inv.memory_modules ?? []).length && !(inv.network_adapters ?? []).length;
  el.innerHTML = `
    ${olderAgent ? '<div class="alert info"><span>Prozessor-, BIOS-, Speicher- und Netzwerkdetails liefert der Agent ab Version 0.10.0 – bitte unter „Maschinen“ den Agent aktualisieren.</span></div>' : ''}
    <div class="stack">
      ${section('Gerät', rows([
        ['Computername', inv.hostname], ['Hersteller', d.manufacturer], ['Modell', d.model], ['Version', d.version],
        ['Prozessor', d.processor], ['Seriennummer', d.serial], ['Arbeitsspeicher (RAM)', d.ram_gb ? `${d.ram_gb} GB` : null], ['BIOS', d.bios],
      ]))}
      ${section('Sicherheit', securityList(inv.security))}
      ${section('Prozessor (CPU)', c ? rows([
        ['Name', c.name], ['Hersteller', c.manufacturer], ['Beschreibung', c.description],
        ['Kerne', c.cores ? (c.threads && c.threads !== c.cores ? `${c.cores} (${c.threads} Threads)` : String(c.cores)) : null],
        ['Taktrate', c.speed_ghz ? `${c.speed_ghz} GHz` : null], ['Datenbreite', c.data_width ? `${c.data_width} Bit` : null],
        ['L2-Cache', c.l2_cache_kb ? (c.l2_cache_kb >= 1024 ? `${(c.l2_cache_kb / 1024).toFixed(c.l2_cache_kb % 1024 ? 1 : 0)} MB` : `${c.l2_cache_kb} KB`) : null],
        ['Architektur', c.architecture],
      ]) : '<p class="muted text-sm">Keine Angaben.</p>')}
      ${section('BIOS', b ? rows([
        ['Hersteller', b.manufacturer], ['Seriennummer', b.serial], ['SMBIOS-Version', b.smbios_version], ['Version', b.version],
        ['Veröffentlicht', b.release_date], ['Software-Kennung', b.software_id],
      ]) : '<p class="muted text-sm">Keine Angaben.</p>')}
      ${section('Speichermodule', (inv.memory_modules ?? []).length
        ? table(['Hersteller', 'Kapazität', 'Teilenummer', 'Steckplatz', 'Bauform', 'Geschwindigkeit'],
          inv.memory_modules.map((r) => [r.manufacturer, `${r.capacity_gb} GB`, r.part_number, r.locator, r.form_factor, r.speed_mhz ? `${r.speed_mhz} MHz` : null]))
        : '<p class="muted text-sm">Keine Angaben – unter Linux braucht das Auslesen der Module Root-Rechte (dmidecode).</p>')}
      ${section('Netzwerkverbindungen', table(['Name', 'MAC-Adresse', 'IPv4-Adresse', 'IPv6-Adresse', 'Verbunden'],
        (inv.network_adapters ?? []).map((n) => [n.name, n.mac, n.ipv4.join(', ') || null, n.ipv6.join(', ') || null,
          html(n.connected ? badge('Ja', 'ok') : badge('Nein', 'bad'))])))}
    </div>`;
}

const APPS_SHOWN = 500;

/** Tab „Anwendungen“: installierte Software mit Suche und Quellenfilter; die Liste wird erst beim Öffnen geladen. */
async function applicationsTab(el, m) {
  el.innerHTML = '<div class="skeleton" style="width:60%"></div>';
  let data;
  try {
    data = await get(`/api/machines/${m.id}/applications`);
  } catch (err) {
    el.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    return;
  }
  const apps = data.applications ?? [];
  if (!apps.length) {
    el.innerHTML = `<div class="alert info"><span>Für diese Maschine liegt noch keine Software-Liste vor. Der Agent (ab Version 0.11.0) meldet sie kurz nach dem Start und danach stündlich${m.agent_outdated ? ' – bitte unter „Maschinen“ den Agent aktualisieren' : ''}.</span></div>`;
    return;
  }
  const sources = [...new Set(apps.map((a) => a.source))].sort();
  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Anwendungen <span class="muted text-sm" id="apps-count"></span></h2>
        <span class="muted text-sm">Aktualisiert: ${esc(fmtDate(data.applications_at))}</span>
      </div>
      <div class="row" style="gap:var(--space-3);margin-bottom:var(--space-3);flex-wrap:wrap">
        <input id="apps-search" type="search" placeholder="Suchen (Name, Hersteller, Version …)" style="flex:1;min-width:220px" />
        ${sources.length > 1 ? `<select id="apps-source"><option value="">Alle Quellen</option>${sources.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Version</th><th>Hersteller</th><th>Kennung</th><th>Quelle</th></tr></thead>
        <tbody id="apps-body"></tbody>
      </table></div>
      <p class="muted text-sm" id="apps-more" style="margin-top:var(--space-3)"></p>
    </div>`;
  let showAll = false;
  const draw = () => {
    const q = $('#apps-search', el).value.trim().toLowerCase();
    const src = $('#apps-source', el)?.value ?? '';
    const hits = apps.filter((a) => (!src || a.source === src)
      && (!q || [a.name, a.version, a.publisher, a.identifier, a.source].some((v) => String(v ?? '').toLowerCase().includes(q))));
    const shown = showAll ? hits : hits.slice(0, APPS_SHOWN);
    $('#apps-count', el).textContent = hits.length === apps.length ? `(${apps.length})` : `(${hits.length} von ${apps.length})`;
    $('#apps-body', el).innerHTML = shown.map((a) => `
      <tr><td>${esc(a.name)}</td><td class="mono text-sm">${esc(a.version || '–')}</td><td class="muted text-sm">${esc(a.publisher || '–')}</td>
        <td class="mono text-sm muted">${esc(a.identifier || '–')}</td><td class="muted text-sm">${esc(a.source)}</td></tr>`).join('')
      || '<tr><td colspan="5"><div class="empty-state">Keine Treffer.</div></td></tr>';
    const more = $('#apps-more', el);
    more.innerHTML = hits.length > shown.length ? `${shown.length} von ${hits.length} angezeigt – <a class="link" href="#" id="apps-all">alle anzeigen</a>` : '';
    $('#apps-all', el)?.addEventListener('click', (e) => { e.preventDefault(); showAll = true; draw(); });
  };
  $('#apps-search', el).addEventListener('input', () => { showAll = false; draw(); });
  $('#apps-source', el)?.addEventListener('change', () => { showAll = false; draw(); });
  draw();
}

const PATCH_LABEL = { critical: 'Kritisch', security: 'Sicherheit', update: 'Update verfügbar' };
const PATCH_KIND = { critical: 'bad', security: 'warn', update: 'accent' };

/** Letztes Installationsergebnis je Maschine (bleibt beim Wechsel zwischen Tabs sichtbar, bis die Seite neu geladen wird). */
const lastInstall = new Map();

/** Tab „Patches“: ausstehende Updates (Betriebssystem und Programme) inkl. Installation, zuletzt installierte Updates; lädt erst beim Öffnen. */
async function patchesTab(el, m) {
  el.innerHTML = '<div class="skeleton" style="width:60%"></div>';
  let data;
  try {
    data = await get(`/api/machines/${m.id}/patches`);
  } catch (err) {
    el.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    return;
  }
  const p = data.patches;
  if (!p) {
    el.innerHTML = `<div class="alert info"><span>Für diese Maschine liegt noch kein Patch-Stand vor. Der Agent (ab Version 0.12.0) prüft ihn kurz nach dem Start und danach alle 6 Stunden${m.agent_outdated ? ' – bitte unter „Maschinen“ den Agent aktualisieren' : ''}. Die erste Prüfung kann einige Minuten dauern.</span></div>`;
    return;
  }
  const level = p.critical > 0 ? 'bad' : p.security > 0 ? 'warn' : 'ok';
  const items = p.items ?? [];
  const isOwner = m.owner_user_id === state.user.id || state.user.system_role === 'admin';
  const installable = items.filter((i) => i.id);
  let installHint = '';
  if (!isOwner) installHint = 'Nur Besitzer oder Admin der Maschine dürfen Updates installieren.';
  else if (m.agent_status !== 'online') installHint = 'Die Maschine ist offline – Updates lassen sich nur bei laufendem Agent installieren.';
  else if (!m.agent_can_install_patches) installHint = 'Zum Installieren von Updates muss der Agent mindestens Version 0.15.0 haben – bitte unter „Maschinen“ aktualisieren.';
  else if (items.length && !installable.length) installHint = 'Dieser Patch-Stand enthält noch keine Installations-Kennungen – er wird mit der nächsten Prüfung (spätestens nach 6 Stunden) aktualisiert.';
  const canInstall = !installHint && installable.length > 0;
  const outcome = lastInstall.get(m.id);

  const rowCells = (i) => {
    const base = [i.vendor, i.name, i.version, i.available, i.kind === 'os' ? 'System' : 'Programm', html(badge(PATCH_LABEL[i.status] || i.status, PATCH_KIND[i.status] || ''))];
    if (!canInstall) return base;
    const pick = i.id ? html(`<input type="checkbox" class="pick" data-id="${esc(i.id)}" data-sec="${i.status !== 'update' ? 1 : 0}" aria-label="${esc(i.name)} auswählen">`) : '';
    const one = i.id ? html(`<button class="btn ghost sm icon-only" data-one="${esc(i.id)}" title="Dieses Update installieren" aria-label="${esc(i.name)} installieren">${icon('download', { size: 16 })}</button>`) : '';
    return [pick, ...base, one];
  };
  const head = ['Hersteller', 'Name', 'Installiert', 'Verfügbar', 'Art', 'Patch-Status'];

  el.innerHTML = `
    <div class="stack">
      ${p.reboot_required ? `<div class="alert warn"><span>${icon('info', { size: 16 })} <strong>Neustart erforderlich.</strong> Nach den Updates muss die Maschine neu gestartet werden. DevDeck startet sie <em>nicht</em> selbst neu – bitte den Neustart manuell am Computer durchführen.</span></div>` : ''}
      <div id="patch-progress"></div>
      ${outcome ? `<div class="card"><div class="card-head"><h2>Ergebnis der letzten Installation</h2><span class="muted text-sm">${esc(fmtDate(outcome.at))}</span></div>
        ${table(['Update', 'Ergebnis', 'Meldung'], outcome.results.map((r) => [r.name || r.id, html(badge(r.ok ? 'Installiert' : 'Fehlgeschlagen', r.ok ? 'ok' : 'bad')), r.message]))}
        ${outcome.reboot_required ? '<p class="text-sm" style="margin-top:var(--space-3)"><strong>Neustart erforderlich</strong> – bitte manuell am Computer durchführen.</p>' : ''}</div>` : ''}
      <div class="card"><div class="card-head"><h2>Zusammenfassung</h2><span class="muted text-sm">Aktualisiert: ${esc(fmtDate(data.patches_at || p.collected_at))}</span></div>
        ${rows([
          ['Gesamtstatus', html(p.total === 0 ? badge('Aktuell', 'ok') : badge(p.critical ? 'Kritische Updates ausstehend' : p.security ? 'Sicherheitsupdates ausstehend' : 'Updates ausstehend', level))],
          ['Ausstehende Updates', String(p.total)],
          ['davon kritisch', String(p.critical)],
          ['davon sicherheitsrelevant (inkl. kritisch)', String(p.security)],
          ['Neustart erforderlich', p.reboot_required === null ? null : html(p.reboot_required ? badge('Ja – manuell durchführen', 'warn') : badge('Nein', 'ok'))],
          ['Zuletzt installiert', p.last_installed_at],
          ['Prüfverfahren', p.scanner],
        ])}
        ${(p.notes ?? []).map((n) => `<p class="muted text-sm" style="margin-top:var(--space-2)">${esc(n)}</p>`).join('')}
      </div>
      <div class="card"><div class="card-head"><h2>Ausstehende Updates ${p.total ? `<span class="muted text-sm">(${p.total}${p.total > items.length ? `, ${items.length} angezeigt` : ''})</span>` : ''}</h2>
          ${canInstall ? `<div class="row" style="gap:var(--space-2);flex-wrap:wrap">
            <button class="btn ghost sm" id="patch-all" type="button">Alle auswählen</button>
            ${items.some((i) => i.id && i.status !== 'update') ? '<button class="btn ghost sm" id="patch-sec" type="button">' + icon('shield-alert', { size: 16 }) + '<span>Sicherheitsupdates</span></button>' : ''}
            <button class="btn sm" id="patch-install" type="button" disabled>${icon('download', { size: 16 })}<span>Ausgewählte installieren</span></button>
          </div>` : ''}
        </div>
        ${installHint ? `<p class="muted text-sm" style="margin:0 0 var(--space-3)">${esc(installHint)}</p>` : ''}
        ${items.length ? table(canInstall ? ['', ...head, ''] : head, items.map(rowCells)) : '<p class="muted text-sm">Keine ausstehenden Updates gefunden.</p>'}
        <p class="muted text-sm" style="margin-top:var(--space-3)">Gelistet wird nur, was ein Update braucht. Was hier nicht steht, ist nach Kenntnis des Systems aktuell – DevDeck führt keine Schwachstellen-Datenbank wie ein Hersteller-Scanner.${canInstall ? ' Beim Installieren wird ein nötiger Neustart nie automatisch ausgeführt, sondern nur angezeigt.' : ''}</p>
      </div>
      ${(p.installed ?? []).length ? `<div class="card"><div class="card-head"><h2>Zuletzt installierte Updates</h2></div>
        ${table(['Kennung', 'Beschreibung', 'Installiert am'], p.installed.map((u) => [u.id, u.description, u.installed_on]))}</div>` : ''}
    </div>`;

  if (!canInstall) return;
  const picks = () => $$('.pick', el);
  const selected = () => picks().filter((c) => c.checked).map((c) => c.dataset.id);
  const sync = () => {
    const n = selected().length;
    const btn = $('#patch-install', el);
    btn.disabled = n === 0;
    btn.querySelector('span').textContent = n ? `${n} installieren` : 'Ausgewählte installieren';
  };
  for (const c of picks()) c.addEventListener('change', sync);
  $('#patch-all', el).addEventListener('click', () => {
    const all = picks().every((c) => c.checked);
    for (const c of picks()) c.checked = !all;
    sync();
  });
  $('#patch-sec', el)?.addEventListener('click', () => {
    for (const c of picks()) c.checked = c.dataset.sec === '1';
    sync();
  });

  const run = async (ids) => {
    const ok = await confirmModal({
      title: ids.length === 1 ? 'Update installieren' : `${ids.length} Updates installieren`,
      message: `Auf „${m.name}“ ${ids.length === 1 ? 'wird 1 Update' : `werden ${ids.length} Updates`} installiert. Das kann mehrere Minuten dauern. Ein nötiger Neustart wird nicht automatisch ausgeführt, sondern nur angezeigt – den führst du anschließend manuell am Computer durch.`,
      confirmLabel: 'Installieren',
      danger: false,
    });
    if (!ok) return;
    const box = $('#patch-progress', el);
    for (const b of $$('button', el)) if (b.id !== 'logout') b.disabled = true;
    box.innerHTML = `<div class="alert info"><span>${icon('hourglass', { size: 16 })} Installation läuft … Das kann je nach Updates mehrere Minuten dauern. Du kannst diese Seite offen lassen.</span></div>`;
    try {
      const { command_id } = await post(`/api/machines/${m.id}/patches/install`, { ids });
      for (let i = 0; i < 450; i += 1) {
        await new Promise((r) => setTimeout(r, 4000));
        const cmd = await get(`/api/machines/${m.id}/commands/${command_id}`);
        if (cmd.status === 'done') {
          lastInstall.set(m.id, { ...cmd.outcome, at: new Date().toISOString() });
          const failed = (cmd.outcome?.results ?? []).filter((r) => !r.ok).length;
          toast(failed ? `Installation abgeschlossen, ${failed} fehlgeschlagen` : 'Updates installiert', failed ? 'error' : 'success');
          document.dispatchEvent(new CustomEvent('devdeck:patches-changed'));
          return patchesTab(el, m);
        }
        if (cmd.status === 'failed' || cmd.status === 'expired') throw new Error(cmd.error || 'Installation fehlgeschlagen');
      }
      throw new Error('Der Agent hat noch nicht geantwortet – siehe Agent-Log');
    } catch (err) {
      toast(err.message, 'error');
      return patchesTab(el, m);
    }
  };
  $('#patch-install', el).addEventListener('click', () => run(selected()));
  for (const b of $$('[data-one]', el)) b.addEventListener('click', () => run([b.dataset.one]));
}

const LOG_LEVEL = { critical: ['Kritisch', 'bad'], error: ['Fehler', 'warn'] };
const MSG_SHOWN = 260;

/** Tab „Logs“: Fehlerprotokolle (Kritisch/Fehler) aus den System-Logs der Maschine, filterbar; lädt erst beim Öffnen. */
async function logsTab(el, m) {
  el.innerHTML = '<div class="skeleton" style="width:60%"></div>';
  const state2 = { source: '', level: '', q: '' };
  const load = async () => {
    const qs = new URLSearchParams({ limit: '200' });
    if (state2.source) qs.set('source', state2.source);
    if (state2.level) qs.set('level', state2.level);
    if (state2.q) qs.set('q', state2.q);
    return get(`/api/machines/${m.id}/logs?${qs}`);
  };
  let data;
  try {
    data = await load();
  } catch (err) {
    el.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    return;
  }
  if (!data.logs_at) {
    el.innerHTML = `<div class="alert info"><span>Für diese Maschine liegen noch keine Logs vor. Der Agent (ab Version 0.13.0) liest sie kurz nach dem Start und danach alle 15 Minuten${m.agent_outdated ? ' – bitte unter „Maschinen“ den Agent aktualisieren' : ''}.</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="stack">
      <div class="card"><div class="card-head"><h2>Fehlerprotokolle</h2><span class="muted text-sm">Zuletzt gelesen: ${esc(fmtDate(data.logs_at))}</span></div>
        <p class="muted text-sm" style="margin:0 0 var(--space-3)">Nur Einträge der Stufen Kritisch und Fehler aus den System-Logs dieser Maschine. Einträge werden ${data.retention_days} Tage aufbewahrt und danach automatisch gelöscht.</p>
        <div class="row" id="log-sources" style="gap:var(--space-2);margin-bottom:var(--space-3)">${data.sources.length
          ? data.sources.map((s) => `<span class="badge">${esc(s.source)}: ${s.count}</span>`).join('')
          : '<span class="muted text-sm">Keine Fehler gespeichert – das ist ein gutes Zeichen.</span>'}</div>
        ${(data.notes ?? []).map((n) => `<p class="muted text-sm">${esc(n)}</p>`).join('')}
        <div class="row" style="gap:var(--space-3);margin-bottom:var(--space-3);flex-wrap:wrap">
          <input id="log-q" type="search" placeholder="Suchen (Meldung, Quelle, ID …)" style="flex:1;min-width:220px" value="${esc(state2.q)}" />
          <select id="log-source"><option value="">Alle Logs</option>${data.sources.map((s) => `<option value="${esc(s.source)}">${esc(s.source)}</option>`).join('')}</select>
          <select id="log-level"><option value="">Kritisch und Fehler</option><option value="critical">Nur kritisch</option><option value="error">Nur Fehler</option></select>
        </div>
        <div id="log-table"></div>
        <p class="muted text-sm" id="log-count" style="margin-top:var(--space-3)"></p>
      </div>
    </div>`;
  const draw = (d) => {
    $('#log-table', el).innerHTML = d.entries.length ? table(['Zeit', 'Log', 'Quelle', 'ID', 'Ebene', 'Meldung'], d.entries.map((e) => [
      fmtDate(e.time), e.source, e.provider, e.event_id,
      html(badge(LOG_LEVEL[e.level]?.[0] ?? e.level, LOG_LEVEL[e.level]?.[1] ?? '')),
      html(`<span class="text-sm" title="${esc(e.message)}">${esc(e.message.length > MSG_SHOWN ? `${e.message.slice(0, MSG_SHOWN)}…` : e.message)}</span>`),
    ])) : '<p class="muted text-sm">Keine passenden Einträge.</p>';
    $('#log-count', el).textContent = `${d.entries.length} Einträge angezeigt (neueste zuerst), ${d.total} gespeichert.`;
  };
  draw(data);
  $('#log-source', el).value = state2.source;
  $('#log-level', el).value = state2.level;
  let timer = null;
  const refresh = () => {
    state2.q = $('#log-q', el).value.trim();
    state2.source = $('#log-source', el).value;
    state2.level = $('#log-level', el).value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { draw(await load()); } catch (err) { toast(err.message, 'error'); }
    }, 250);
  };
  $('#log-q', el).addEventListener('input', refresh);
  $('#log-source', el).addEventListener('change', refresh);
  $('#log-level', el).addEventListener('change', refresh);
}

/** Weitere Tabs (Einstellungen, Action-Log, …) kommen hier später dazu. */
const TABS = [
  { key: 'main', label: 'Übersicht', render: mainTab },
  { key: 'inventory', label: 'Inventar', render: inventoryTab },
  { key: 'applications', label: 'Anwendungen', render: applicationsTab },
  { key: 'patches', label: 'Patches', render: patchesTab },
  { key: 'logs', label: 'Logs', render: logsTab },
];

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
