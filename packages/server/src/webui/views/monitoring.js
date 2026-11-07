import { get, post, patch, del } from '../lib/api.js';
import { $, $$, esc, badge, timeAgo, toast, openModal, closeModal, setModalError, confirmModal } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

const STATUS = {
  ok: { label: 'OK', cls: 'ok' },
  warn: { label: 'Warnung', cls: 'warn' },
  error: { label: 'Ausfall', cls: 'bad' },
  unknown: { label: 'unbekannt', cls: 'unknown' },
};
const KIND_LABEL = {
  http: 'Website / API (HTTP)', tcp: 'Port / Mail-Server (TCP)', systemd: 'Dienst auf Maschine (systemd)', machine: 'Maschine online', disk: 'Datenträger', patches: 'Updates (Patches)',
  backup: 'Backup aktuell', replica: 'Backup-Replik', connector: 'Integration',
};
const KIND_HELP = {
  http: 'Ruft eine Adresse ab und prüft Statuscode, Antwortzeit, optional Text oder JSON-Zeilen und das Zertifikat. Für Vercel-Seiten, Supabase, APIs, Karten-Kacheln.',
  tcp: 'Prüft, ob ein Port erreichbar ist (z. B. Mail-Server smtp.ionos.de:465 mit TLS, Datenbank-Port) – inklusive Zertifikatsablauf bei TLS.',
  systemd: 'Fragt auf einer Maschine ab, ob ein systemd-Dienst läuft (z. B. helferle-api). Läuft per Agent.',
  machine: 'Grün, solange der Agent der Maschine meldet; rot, wenn sie offline ist.',
  disk: 'Warnt, wenn auf einem Datenträger der Maschine der freie Platz knapp wird.',
  patches: 'Gelb bei ausstehenden Sicherheitsupdates oder nötigem Neustart, rot bei kritischen Updates.',
  backup: 'Warnt, wenn das letzte erfolgreiche Backup eines Jobs (oder die System-Backups) zu alt ist.',
  replica: 'Prüft, ob die Backup-Replik auf der zweiten Maschine synchron ist.',
  connector: 'Übernimmt das Ergebnis der Prüfung einer Integration (z. B. GitHub).',
};
const FORMAT_SECONDS = (s) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

const qs = (name) => new URLSearchParams((location.hash.split('?')[1]) || '').get(name);

function dot(status, extra = '') {
  return `<span class="mon-dot ${STATUS[status]?.cls ?? 'unknown'} ${extra}" title="${esc(STATUS[status]?.label ?? status)}" role="img" aria-label="${esc(STATUS[status]?.label ?? status)}"></span>`;
}

function spark(m) {
  const h = m.history ?? [];
  if (!h.length) return '<span class="muted text-sm">–</span>';
  const bars = h.map((x) => `<i class="mon-bar ${STATUS[x.status]?.cls ?? 'unknown'}" title="${esc(timeAgo(x.at))}: ${esc(STATUS[x.status]?.label ?? x.status)}${x.latency_ms != null ? `, ${x.latency_ms} ms` : ''}"></i>`).join('');
  return `<span class="mon-spark">${bars}</span>`;
}

function row(m, canManage) {
  const eff = m.enabled ? m.effective_status : 'unknown';
  return `
    <tr class="${m.enabled ? '' : 'muted-row'}" data-id="${esc(m.id)}">
      <td class="mon-status">${dot(eff)}</td>
      <td>
        <strong>${esc(m.name)}</strong>
        ${m.environment === 'dev' ? badge('Entwicklung', 'accent') : ''}${m.group ? ` <span class="badge">${esc(m.group)}</span>` : ''}${m.enabled ? '' : ` ${badge('pausiert', 'warn')}`}
        <br><span class="muted text-sm mono">${esc(m.target)}</span>
        <br><span class="${m.status === 'error' ? 'error' : 'muted'} text-sm">${esc(m.message || (m.enabled ? 'Noch keine Prüfung' : ''))}</span>
      </td>
      <td class="text-sm">${m.latency_ms != null ? `${m.latency_ms} ms` : '–'}</td>
      <td class="text-sm">${m.uptime_24h != null ? `${m.uptime_24h} %` : '–'}</td>
      <td>${spark(m)}</td>
      <td class="muted text-sm">${m.last_checked_at ? esc(timeAgo(m.last_checked_at)) : 'nie'}${m.status_since ? `<br>seit ${esc(timeAgo(m.status_since))}` : ''}</td>
      <td class="actions">${canManage ? `
        <button class="btn ghost sm icon-only" data-check="${esc(m.id)}" title="Jetzt prüfen" aria-label="Jetzt prüfen">${icon('refresh', { size: 16 })}</button>
        <button class="btn ghost sm icon-only" data-edit="${esc(m.id)}" title="Bearbeiten" aria-label="Bearbeiten">${icon('edit', { size: 16 })}</button>
        <button class="btn ghost sm icon-only" data-toggle="${esc(m.id)}" title="${m.enabled ? 'Pausieren' : 'Fortsetzen'}" aria-label="${m.enabled ? 'Pausieren' : 'Fortsetzen'}">${icon(m.enabled ? 'pause' : 'play', { size: 16 })}</button>
        <button class="btn ghost sm icon-only danger" data-delete="${esc(m.id)}" title="Löschen" aria-label="Löschen">${icon('trash', { size: 16 })}</button>` : ''}</td>
    </tr>`;
}

export async function renderMonitoring(el) {
  const projectFilter = qs('project') || '';
  const data = await get(`/api/monitoring${projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : ''}`);
  const filters = { env: sessionStorageGet('mon-env') || '', status: sessionStorageGet('mon-status') || '' };
  const canManageProject = (id) => (id ? data.projects.find((p) => p.id === id)?.can_manage : data.can_manage_system);
  const anyManage = data.can_manage_system || data.projects.some((p) => p.can_manage);

  const visible = data.monitors.filter((m) => (!filters.env || m.environment === filters.env) && (!filters.status || (filters.status === 'problems' ? ['warn', 'error'].includes(m.effective_status) : m.effective_status === filters.status)));
  const byProject = new Map();
  for (const m of visible) {
    const key = m.project?.id ?? '__system';
    byProject.set(key, [...(byProject.get(key) ?? []), m]);
  }
  const groups = [...byProject.entries()].map(([key, list]) => {
    const proj = key === '__system' ? null : data.projects.find((p) => p.id === key);
    const mon = proj?.monitoring;
    const worst = mon && mon.status !== 'none' ? mon.status : (list.some((m) => m.effective_status === 'error') ? 'error' : list.some((m) => m.effective_status === 'warn') ? 'warn' : list.every((m) => m.effective_status === 'unknown') ? 'unknown' : 'ok');
    return `
      <div class="card" data-project="${esc(key)}">
        <div class="card-head">
          <h2>${dot(worst, 'big')} ${key === '__system' ? 'DevDeck (System)' : `<a class="link" href="#/projects/${esc(key)}">${esc(proj?.name ?? list[0].project?.name ?? '?')}</a>`}</h2>
          ${canManageProject(key === '__system' ? null : key) ? `<div class="btn-group">
            <button class="btn ghost sm" data-suggest="${esc(key === '__system' ? '' : key)}">${icon('layers', { size: 14 })}Vorschläge</button>
            <button class="btn ghost sm" data-add="${esc(key)}">${icon('plus', { size: 14 })}Monitor</button></div>` : ''}
        </div>
        <div class="table-wrap"><table class="mon-table">
          <thead><tr><th></th><th>Monitor</th><th>Antwort</th><th>24 h</th><th>Verlauf</th><th>Geprüft</th><th></th></tr></thead>
          <tbody>${list.map((m) => row(m, canManageProject(m.project?.id ?? null))).join('')}</tbody>
        </table></div>
      </div>`;
  }).join('');

  const s = data.summary;
  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Monitoring</h1>
        <p class="lede">Überwachung der Produktions- und Entwicklungsumgebungen: Websites, Datenbanken (Supabase), Hosting (Vercel), Mail-Server, Karten, Server, Dienste, Backups. Rot = Ausfall, Gelb = Warnung, Grün = in Ordnung.</p>
      </div>
      ${anyManage ? `<div class="page-actions"><button class="btn" id="btn-add">${icon('plus')}Monitor hinzufügen</button></div>` : ''}
    </div>
    <div class="mon-tiles">
      ${[['error', 'Ausfälle', s.error], ['warn', 'Warnungen', s.warn], ['ok', 'in Ordnung', s.ok], ['unknown', 'ohne Messung', s.unknown]].map(([k, l, n]) => `
        <button class="mon-tile ${STATUS[k].cls} ${filters.status === k ? 'active' : ''}" data-status="${k}">${dot(k)}<span class="n">${n}</span><span class="l">${l}</span></button>`).join('')}
    </div>
    <div class="row mon-filters" style="gap:var(--space-3);flex-wrap:wrap;margin:var(--space-3) 0">
      <select id="f-project" aria-label="Projekt"><option value="">Alle Projekte</option>${data.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === projectFilter ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <select id="f-env" aria-label="Umgebung"><option value="">Produktion und Entwicklung</option><option value="prod" ${filters.env === 'prod' ? 'selected' : ''}>Nur Produktion</option><option value="dev" ${filters.env === 'dev' ? 'selected' : ''}>Nur Entwicklung</option></select>
      <select id="f-status" aria-label="Status"><option value="">Alle Zustände</option><option value="problems" ${filters.status === 'problems' ? 'selected' : ''}>Nur Probleme</option></select>
    </div>
    ${groups || `<div class="card"><div class="empty-state"><div class="icon">${icon('activity', { size: 32 })}</div>${data.monitors.length ? 'Keine Monitore für diesen Filter.' : 'Noch keine Monitore.'}${anyManage ? ' Mit „Vorschläge“ legst du passende Monitore aus den Daten des Projekts an.' : ''}</div></div>`}
    ${anyManage && !projectFilter ? `<div class="card"><div class="card-head"><h2>Schnellstart</h2></div><p class="muted text-sm">Für jedes Projekt, das du verwalten darfst, erkennt DevDeck passende Monitore (Backups, Repliken, Supabase aus dem Vault, Domains und Mail-Server aus der Architektur-Karte, Integrationen).</p><div class="row" style="gap:var(--space-2);flex-wrap:wrap">${data.projects.filter((p) => p.can_manage).map((p) => `<button class="btn ghost sm" data-suggest="${esc(p.id)}">Vorschläge für ${esc(p.name)}</button>`).join('')}${data.can_manage_system ? '<button class="btn ghost sm" data-suggest="">Vorschläge für DevDeck (System)</button>' : ''}</div></div>` : ''}`;

  const reload = () => renderMonitoring(el);
  $('#f-project', el).addEventListener('change', (e) => { location.hash = e.target.value ? `#/monitoring?project=${e.target.value}` : '#/monitoring'; });
  $('#f-env', el).addEventListener('change', (e) => { sessionStorageSet('mon-env', e.target.value); reload(); });
  $('#f-status', el).addEventListener('change', (e) => { sessionStorageSet('mon-status', e.target.value); reload(); });
  $$('.mon-tile', el).forEach((b) => b.addEventListener('click', () => { sessionStorageSet('mon-status', filters.status === b.dataset.status ? '' : b.dataset.status); reload(); }));

  const act = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok, 'success'); } catch (err) { toast(err.message, 'error'); }
    reload();
  };
  const find = (id) => data.monitors.find((m) => m.id === id);
  $$('[data-check]', el).forEach((b) => b.addEventListener('click', () => act(() => post(`/api/monitors/${b.dataset.check}/check`), 'Geprüft')));
  $$('[data-toggle]', el).forEach((b) => b.addEventListener('click', () => { const m = find(b.dataset.toggle); act(() => patch(`/api/monitors/${m.id}`, { enabled: !m.enabled }), m.enabled ? 'Pausiert' : 'Fortgesetzt'); }));
  $$('[data-delete]', el).forEach((b) => b.addEventListener('click', async () => {
    const m = find(b.dataset.delete);
    if (await confirmModal({ title: `Monitor „${m.name}“ löschen?`, message: 'Der Monitor und sein Verlauf werden gelöscht.', confirmLabel: 'Löschen' })) act(() => del(`/api/monitors/${m.id}`, { confirm: true }), 'Monitor gelöscht');
  }));
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => monitorModal(data, find(b.dataset.edit), null, reload)));
  $('#btn-add', el)?.addEventListener('click', () => monitorModal(data, null, projectFilter || null, reload));
  $$('[data-add]', el).forEach((b) => b.addEventListener('click', () => monitorModal(data, null, b.dataset.add === '__system' ? '' : b.dataset.add, reload)));
  $$('[data-suggest]', el).forEach((b) => b.addEventListener('click', () => suggestModal(data, b.dataset.suggest || null, reload)));

  // laufend aktualisieren, solange die Ansicht offen ist und kein Dialog
  setTimeout(() => { if (el.isConnected && location.hash.startsWith('#/monitoring') && !document.querySelector('.modal')) reload(); }, 20_000);
}

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ohne Speicher */ } }

// ── Vorschläge ──

async function suggestModal(data, projectId, reload) {
  let list;
  try {
    list = await get(`/api/monitors/suggestions${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const fresh = list.filter((s) => !s.exists);
  const name = projectId ? data.projects.find((p) => p.id === projectId)?.name : 'DevDeck (System)';
  openModal(`
    <h2>${icon('layers', { size: 20 })} Vorschläge für ${esc(name)}</h2>
    <p class="muted text-sm">DevDeck leitet sie aus Backup-Jobs, Repliken, Integrationen, Supabase-Zugangsdaten im Vault (nur URL und öffentlicher anon-Schlüssel) sowie Domains und Mail-Servern der Architektur-Karte ab.</p>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Monitor</th><th>Art</th><th>Grund</th><th></th></tr></thead><tbody>${list.map((s) => `
      <tr><td><strong>${esc(s.name)}</strong>${s.environment === 'dev' ? ' ' + badge('Entwicklung', 'accent') : ''}</td><td class="text-sm">${esc(KIND_LABEL[s.kind] ?? s.kind)}</td><td class="muted text-sm">${esc(s.reason)}</td><td>${s.exists ? badge('vorhanden', 'ok') : badge('neu', 'accent')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="alert info"><span>Es gibt nichts Passendes zum Vorschlagen. Monitore lassen sich mit „Monitor hinzufügen“ von Hand anlegen.</span></div>'}
    <p class="error" id="modal-error"></p>
    <div class="modal-actions"><button class="btn ghost" id="sg-cancel" type="button">Schließen</button>${fresh.length ? `<button class="btn" id="sg-go" type="button">${icon('check', { size: 16 })}<span>${fresh.length} Monitor${fresh.length === 1 ? '' : 'e'} anlegen</span></button>` : ''}</div>`, (root) => {
    $('#sg-cancel', root).addEventListener('click', closeModal);
    $('#sg-go', root)?.addEventListener('click', async () => {
      try {
        const r = await post('/api/monitors/seed', { project_id: projectId });
        closeModal();
        toast(`${r.created} Monitor${r.created === 1 ? '' : 'e'} angelegt${r.failed.length ? `, ${r.failed.length} nicht möglich (${r.failed[0].error})` : ''}`, r.failed.length ? 'error' : 'success');
        reload();
      } catch (err) { setModalError(root, err.message); }
    });
  });
}

// ── Monitor anlegen / bearbeiten ──

function field(label, html, hint = '') { return `<label>${esc(label)} ${html}${hint ? `<span class="muted text-sm">${hint}</span>` : ''}</label>`; }

function monitorModal(data, existing, presetProject, reload) {
  const creating = !existing;
  const projectId = existing ? (existing.project?.id ?? '') : (presetProject ?? (data.projects.find((p) => p.can_manage)?.id ?? ''));
  const manageable = [{ id: '', name: 'DevDeck (System)', ok: data.can_manage_system }, ...data.projects.map((p) => ({ id: p.id, name: p.name, ok: p.can_manage }))].filter((p) => p.ok);
  const kinds = Object.keys(KIND_LABEL).filter((k) => creating || k === existing.kind);
  const cfg = existing?.config ?? {};
  const headerRows = (cfg.headers ?? []).map((h) => h.secret ? `${h.name}: secret:${h.secret.name}` : `${h.name}: ${h.value ?? ''}`).join('\n');
  const state = { kind: existing?.kind ?? 'http' };

  openModal(`
    <h2>${creating ? 'Monitor hinzufügen' : `Monitor „${esc(existing.name)}“ bearbeiten`}</h2>
    <form id="mon-form" class="stack">
      <div class="inst-grid">
        ${field('Projekt', `<select id="mf-project" ${creating ? '' : 'disabled'}>${manageable.map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`)}
        ${field('Umgebung', `<select id="mf-env"><option value="prod" ${existing?.environment !== 'dev' ? 'selected' : ''}>Produktion</option><option value="dev" ${existing?.environment === 'dev' ? 'selected' : ''}>Entwicklung (höchstens Warnung)</option></select>`)}
      </div>
      ${field('Art', `<select id="mf-kind" ${creating ? '' : 'disabled'}>${kinds.map((k) => `<option value="${k}" ${k === state.kind ? 'selected' : ''}>${esc(KIND_LABEL[k])}</option>`).join('')}</select>`, '')}
      <p class="muted text-sm" id="mf-help"></p>
      ${field('Name', `<input id="mf-name" required maxlength="120" value="${esc(existing?.name ?? '')}" placeholder="z. B. Website Produktion" />`)}
      <div id="mf-fields" class="stack"></div>
      <div class="inst-grid">
        ${field('Gruppe (optional)', `<input id="mf-group" maxlength="60" value="${esc(existing?.group ?? '')}" placeholder="z. B. Hosting (Vercel)" />`)}
        ${field('Prüfintervall', `<select id="mf-interval">${[30, 60, 120, 300, 600, 900, 1800, 3600, 21600].map((s) => `<option value="${s}" ${s === (existing?.interval_seconds ?? 300) ? 'selected' : ''}>alle ${FORMAT_SECONDS(s)}</option>`).join('')}</select>`)}
      </div>
      <label class="toggle"><input type="checkbox" role="switch" id="mf-cap" ${existing?.severity_cap === 'warn' ? 'checked' : ''}><span class="track"></span>Zeigt höchstens „Warnung“ (z. B. für Abhängigkeiten, die das Projekt nicht lahmlegen)</label>
      <p class="error" id="modal-error"></p>
      <div class="modal-actions"><button class="btn ghost" type="button" id="mf-cancel">Abbrechen</button><button class="btn" type="submit" id="mf-save">${icon('check', { size: 16 })}<span>${creating ? 'Anlegen und prüfen' : 'Speichern'}</span></button></div>
    </form>`, (root) => {
    const q = (s) => root.querySelector(s);
    const machineSelect = (id, selected) => `<select id="${id}">${data.machines.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)} (${esc(m.platform)}, ${esc(m.agent_status)})</option>`).join('')}</select>`;
    const jobsFor = (pid) => data.jobs.filter((j) => j.project_id === pid);
    const draw = () => {
      const kind = q('#mf-kind').value;
      const pid = q('#mf-project').value;
      q('#mf-help').textContent = KIND_HELP[kind] ?? '';
      const mid = existing?.machine?.id ?? '';
      const f = {
        http: `${field('Adresse (URL)', `<input id="c-url" required value="${esc(cfg.url ?? '')}" placeholder="https://www.beispiel.de/" />`)}
          <div class="inst-grid">
            ${field('Erwartet', `<select id="c-expect"><option value="ok" ${cfg.expect !== 'reachable' && cfg.expect !== 'status' ? 'selected' : ''}>Erfolg (200–399)</option><option value="reachable" ${cfg.expect === 'reachable' ? 'selected' : ''}>Erreichbar (jede Antwort unter 500, z. B. 401)</option><option value="status" ${cfg.expect === 'status' ? 'selected' : ''}>Genau dieser Status</option></select>`)}
            ${field('Status (bei „genau“)', `<input id="c-status" type="number" min="100" max="599" value="${esc(cfg.status ?? 200)}" />`)}
            ${field('Antwort enthält (optional)', `<input id="c-contains" maxlength="200" value="${esc(cfg.contains ?? '')}" />`)}
            ${field('Warnung ab (ms)', `<input id="c-warn" type="number" min="100" value="${esc(cfg.warn_latency_ms ?? 3000)}" />`)}
          </div>
          ${field('Header (optional, eine Zeile je Header)', `<textarea id="c-headers" rows="2" placeholder="apikey: secret:NEXT_PUBLIC_SUPABASE_ANON_KEY">${esc(headerRows)}</textarea>`, 'Mit „secret:NAME“ wird der Wert aus dem Vault des Projekts (Umgebung production) geholt und nie angezeigt. Normale Werte werden im Klartext gespeichert – keine Geheimnisse eintragen.')}
          ${field('Von Maschine aus prüfen (optional)', `<select id="c-machine"><option value="">Vom DevDeck-Server aus</option>${data.machines.map((m) => `<option value="${esc(m.id)}" ${m.id === mid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`, 'Für interne Adressen wie http://localhost:5001/health – Header mit Secrets laufen nur vom Server aus.')}`,
        tcp: `<div class="inst-grid">${field('Host', `<input id="c-host" required value="${esc(cfg.host ?? '')}" placeholder="smtp.ionos.de" />`)}${field('Port', `<input id="c-port" type="number" min="1" max="65535" required value="${esc(cfg.port ?? '')}" placeholder="465" />`)}</div>
          <label class="toggle"><input type="checkbox" role="switch" id="c-tls" ${cfg.tls ? 'checked' : ''}><span class="track"></span>TLS-Verbindung und Zertifikat prüfen</label>
          ${field('Von Maschine aus prüfen (optional)', `<select id="c-machine"><option value="">Vom DevDeck-Server aus</option>${data.machines.map((m) => `<option value="${esc(m.id)}" ${m.id === mid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`)}`,
        systemd: `${field('Maschine', machineSelect('c-machine-req', mid))}<div class="inst-grid">${field('Dienst (Unit)', `<input id="c-unit" required value="${esc(cfg.unit ?? '')}" placeholder="helferle-api" />`)}${field('Art', `<select id="c-scope"><option value="user" ${cfg.scope !== 'system' ? 'selected' : ''}>Benutzerdienst (systemctl --user)</option><option value="system" ${cfg.scope === 'system' ? 'selected' : ''}>Systemdienst</option></select>`)}</div>`,
        machine: field('Maschine', machineSelect('c-machine-req', mid)),
        disk: `${field('Maschine', machineSelect('c-machine-req', mid))}<div class="inst-grid">${field('Warnung unter (% frei)', `<input id="c-warn-free" type="number" min="1" max="90" value="${esc(cfg.warn_free_pct ?? 15)}" />`)}${field('Ausfall unter (% frei)', `<input id="c-err-free" type="number" min="1" max="89" value="${esc(cfg.error_free_pct ?? 5)}" />`)}</div>`,
        patches: field('Maschine', machineSelect('c-machine-req', mid)),
        backup: `${field('Backup', `<select id="c-target">${!pid ? '<option value="system">System-Backups von DevDeck</option>' : jobsFor(pid).map((j) => `<option value="${esc(j.id)}" ${j.id === cfg.target ? 'selected' : ''}>${esc(j.name)}</option>`).join('') || '<option value="">(kein Backup-Job im Projekt)</option>'}</select>`)}<div class="inst-grid">${field('Warnung nach (Stunden)', `<input id="c-warn-h" type="number" min="1" value="${esc(cfg.warn_hours ?? 36)}" />`)}${field('Ausfall nach (Stunden)', `<input id="c-err-h" type="number" min="1" value="${esc(cfg.error_hours ?? 72)}" />`)}</div>`,
        replica: field('Backup', `<select id="c-target">${!pid ? '<option value="system">System-Backups von DevDeck</option>' : jobsFor(pid).map((j) => `<option value="${esc(j.id)}" ${j.id === cfg.target ? 'selected' : ''}>${esc(j.name)}</option>`).join('') || '<option value="">(kein Backup-Job im Projekt)</option>'}</select>`),
        connector: field('Integration', `<select id="c-connector">${data.connectors.filter((c) => c.project_id === pid).map((c) => `<option value="${esc(c.id)}" ${c.id === cfg.connector_id ? 'selected' : ''}>${esc(c.name || c.type)} (${esc(c.type)})</option>`).join('') || '<option value="">(keine Integration im Projekt)</option>'}</select>`),
      };
      q('#mf-fields').innerHTML = f[kind] ?? '';
    };
    const collect = () => {
      const kind = q('#mf-kind').value;
      const val = (id) => q(`#${id}`)?.value ?? '';
      let config = {};
      let machine_id = null;
      if (kind === 'http') {
        const headers = val('c-headers').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, ...rest] = l.split(':');
          const v = rest.join(':').trim();
          const m = /^secret:(.+)$/.exec(v);
          return m ? { name: name.trim(), secret: { name: m[1].trim(), environment: 'production' } } : { name: name.trim(), value: v };
        });
        config = { url: val('c-url').trim(), expect: val('c-expect'), status: Number(val('c-status')), contains: val('c-contains').trim() || undefined, warn_latency_ms: Number(val('c-warn')), headers };
        machine_id = val('c-machine') || null;
      } else if (kind === 'tcp') {
        config = { host: val('c-host').trim(), port: Number(val('c-port')), tls: q('#c-tls').checked };
        machine_id = val('c-machine') || null;
      } else if (kind === 'systemd') { config = { unit: val('c-unit').trim(), scope: val('c-scope') }; machine_id = val('c-machine-req'); }
      else if (kind === 'machine' || kind === 'patches') machine_id = val('c-machine-req');
      else if (kind === 'disk') { config = { warn_free_pct: Number(val('c-warn-free')), error_free_pct: Number(val('c-err-free')) }; machine_id = val('c-machine-req'); }
      else if (kind === 'backup') config = { target: val('c-target'), warn_hours: Number(val('c-warn-h')), error_hours: Number(val('c-err-h')) };
      else if (kind === 'replica') config = { target: val('c-target') };
      else if (kind === 'connector') config = { connector_id: val('c-connector') };
      return { kind, config, machine_id };
    };
    q('#mf-kind').addEventListener('change', draw);
    q('#mf-project').addEventListener('change', draw);
    draw();
    q('#mf-cancel').addEventListener('click', closeModal);
    q('#mon-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = q('#mf-save');
      btn.disabled = true;
      const { kind, config, machine_id } = collect();
      const body = { name: q('#mf-name').value.trim(), environment: q('#mf-env').value, group: q('#mf-group').value.trim(), interval_seconds: Number(q('#mf-interval').value), severity_cap: q('#mf-cap').checked ? 'warn' : 'error', config, machine_id };
      try {
        if (creating) await post('/api/monitors', { ...body, kind, project_id: q('#mf-project').value || null });
        else await patch(`/api/monitors/${existing.id}`, body);
        closeModal();
        toast(creating ? 'Monitor angelegt' : 'Monitor gespeichert', 'success');
        reload();
      } catch (err) {
        setModalError(root, err.message);
        btn.disabled = false;
      }
    });
  });
}
