import { get, post, put, del } from '../../lib/api.js';
import { $, $$, esc, toast, openModal, closeModal, confirmModal, fmtDate } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';

/** Architektur-Karte: weißes Feld über die volle Breite – Komponenten als Karten, Beziehungen als beschriftete Pfeile. */

const KIND = {
  dev: { label: 'Entwicklung', color: '#2563eb' },
  repo: { label: 'Repository', color: '#334155' },
  hosting: { label: 'Betrieb / Hosting', color: '#059669' },
  database: { label: 'Datenbank', color: '#d97706' },
  storage: { label: 'Speicher', color: '#b45309' },
  service: { label: 'Externer Dienst', color: '#7c3aed' },
  llm: { label: 'KI-Modell', color: '#db2777' },
  mail: { label: 'E-Mail', color: '#0891b2' },
  messaging: { label: 'Nachrichten', color: '#0284c7' },
  map: { label: 'Karten', color: '#65a30d' },
  payment: { label: 'Zahlung', color: '#ca8a04' },
  other: { label: 'Sonstiges', color: '#64748b' },
};
const SOURCE_LABEL = { auto: 'automatisch erkannt', manifest: 'aus .devdeck/architecture.yaml', manual: 'manuell angepasst' };
const STATUS_COLOR = { ok: '#16a34a', warn: '#d97706', bad: '#dc2626', unknown: '#94a3b8' };
const NODE_GAP = 22;
const COL_GAP = 96;

const colOf = (c, primaryHostingKeys) => {
  if (c.kind === 'dev') return 0;
  if (c.kind === 'repo') return 1;
  if (c.kind === 'hosting') return primaryHostingKeys.has(c.key) ? 2 : 3;
  if (c.kind === 'database' || c.kind === 'storage') return 3;
  return 'service';
};

function nodeHtml(c) {
  const k = KIND[c.kind] ?? KIND.other;
  const details = c.details.slice(0, 3).map((d) => `<div class="an-detail"><span>${esc(d.label)}:</span> ${esc(d.value)}</div>`).join('');
  const more = c.details.length > 3 ? `<div class="an-detail">+${c.details.length - 3} weitere …</div>` : '';
  return `
    <div class="an-node ${c.placeholder ? 'placeholder' : ''}" data-key="${esc(c.key)}" style="--kc:${k.color}" tabindex="0" role="button" aria-label="${esc(c.name)}">
      <div class="an-head"><span>${esc(k.label)}</span>${c.status ? `<i class="an-dot" style="background:${STATUS_COLOR[c.status]}" title="${esc(c.status)}"></i>` : ''}</div>
      <div class="an-body">
        <div class="an-title">${esc(c.name)}</div>
        ${c.provider ? `<div class="an-provider">${esc(c.provider)}</div>` : ''}
        ${c.description ? `<div class="an-desc">${esc(c.description)}</div>` : ''}
        ${details}${more}
      </div>
    </div>`;
}

/** Positioniert die Karten spaltenweise und zeichnet die Pfeile (SVG) darüber. */
function layout(stage, model) {
  const nodes = new Map($$('.an-node', stage).map((n) => [n.dataset.key, n]));
  const svg = $('svg.an-edges', stage);
  const hostings = model.components.filter((c) => c.kind === 'hosting');
  const primary = new Set(hostings.filter((h) => h.key !== 'hosting:webspace').map((h) => h.key));
  if (primary.size === 0) hostings.forEach((h) => primary.add(h.key));

  const cols = [[], [], [], []];
  const services = [];
  for (const c of model.components) {
    const col = colOf(c, primary);
    if (col === 'service') services.push(c.key); else cols[col].push(c.key);
  }
  const used = cols.map((c, i) => (c.length ? i : -1)).filter((i) => i >= 0);
  const width = stage.clientWidth;
  const slots = Math.max(used.length, services.length ? Math.min(4, Math.max(used.length, 3)) : used.length, 1);
  const nodeW = Math.max(190, Math.min(260, (width - (slots - 1) * COL_GAP - 32) / slots));
  const xOfCol = new Map(used.map((c, i) => [c, 16 + i * (nodeW + COL_GAP)]));
  const pos = new Map();

  for (const n of nodes.values()) n.style.width = `${nodeW}px`;
  const colHeights = used.map((ci) => cols[ci].reduce((h, k) => h + nodes.get(k).offsetHeight, 0) + (cols[ci].length - 1) * NODE_GAP);
  const mainH = Math.max(0, ...colHeights);
  used.forEach((ci, idx) => {
    let y = 16 + (mainH - colHeights[idx]) / 2;
    for (const k of cols[ci]) {
      const n = nodes.get(k);
      pos.set(k, { x: xOfCol.get(ci), y, w: nodeW, h: n.offsetHeight });
      y += n.offsetHeight + NODE_GAP;
    }
  });

  // Dienste: Raster unterhalb, gespeist über eine Sammelleitung vom Betrieb
  let bottom = 16 + mainH;
  const perRow = Math.max(1, Math.floor((width - 32 + COL_GAP) / (nodeW + COL_GAP)));
  const busY = bottom + 46;
  if (services.length) {
    let y = busY + 52;
    for (let i = 0; i < services.length; i += perRow) {
      const row = services.slice(i, i + perRow);
      const rowH = Math.max(...row.map((k) => nodes.get(k).offsetHeight));
      const r = i / perRow;
      row.forEach((k, j) => pos.set(k, { x: 16 + j * (nodeW + COL_GAP), y, w: nodeW, h: nodes.get(k).offsetHeight, row: r, col: j, bus: r === 0 ? busY : y - 50 }));
      y += rowH + 74;
    }
    bottom = y - 74 + 16;
  } else {
    bottom += 16;
  }
  for (const [k, p] of pos) Object.assign(nodes.get(k).style, { left: `${p.x}px`, top: `${p.y}px` });
  stage.style.height = `${bottom + 8}px`;
  svg.setAttribute('width', width);
  svg.setAttribute('height', bottom + 8);
  svg.setAttribute('viewBox', `0 0 ${width} ${bottom + 8}`);

  const serviceSet = new Set(services);
  const parts = [`<defs><marker id="an-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#64748b"/></marker></defs>`];
  const labelBoxes = [];
  const label = (x, y, text, linkIdx) => {
    const w = Math.min(170, text.length * 6.4 + 14);
    labelBoxes.push(`<g class="an-label" data-link="${linkIdx}" transform="translate(${x - w / 2},${y - 10})">
      <rect width="${w}" height="20" rx="10" fill="#fff" stroke="#cbd5e1"/><text x="${w / 2}" y="14" text-anchor="middle" font-size="11" fill="#334155">${esc(text.length > 26 ? `${text.slice(0, 25)}…` : text)}</text></g>`);
  };
  const busFrom = new Map(); // Quelle → Sammelleitung
  model.links.forEach((l, i) => {
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) return;
    const dash = l.dashed ? 'stroke-dasharray="6 5"' : '';
    const stroke = `stroke="#64748b" stroke-width="1.6" fill="none" ${dash}`;
    if (serviceSet.has(l.to)) {
      // Sammelleitung: von der Unterkante der Quelle nach unten, waagerecht, dann zum Dienst
      const sx = a.x + a.w / 2;
      const sy = a.y + a.h;
      const tx = b.x + b.w / 2;
      // Weitere Reihen: Der Weg nach unten läuft durch die Lücke zwischen den Spalten, nie durch eine Karte
      const gx = b.col > 0 ? b.x - COL_GAP / 2 : b.x + b.w + COL_GAP / 2;
      const route = b.row > 0 ? `V${busY} H${gx} V${b.bus} H${tx}` : `V${busY} H${tx}`;
      parts.push(`<path d="M${sx} ${sy} ${route} V${b.y - 2}" ${stroke} marker-end="url(#an-arrow)"/>`);
      busFrom.set(l.from, true);
      label(tx, b.y - 22, l.label, i);
    } else if (Math.abs(a.x - b.x) < 4) {
      // gleiche Spalte: senkrecht
      const down = b.y > a.y;
      const sx = a.x + a.w / 2;
      parts.push(`<path d="M${sx} ${down ? a.y + a.h : a.y} V${down ? b.y - 2 : b.y + b.h + 2}" ${stroke} marker-end="url(#an-arrow)"/>`);
      label(sx, (a.y + b.y + (down ? a.h : b.h)) / 2, l.label, i);
    } else {
      const forward = b.x > a.x;
      const sx = forward ? a.x + a.w : a.x;
      const tx = forward ? b.x - 2 : b.x + b.w + 2;
      const sy = a.y + a.h / 2;
      const ty = b.y + b.h / 2;
      const dx = Math.max(30, Math.abs(tx - sx) / 2);
      const c = forward ? dx : -dx;
      parts.push(`<path d="M${sx} ${sy} C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}" ${stroke} marker-end="url(#an-arrow)"/>`);
      label((sx + tx) / 2, (sy + ty) / 2, l.label, i);
    }
  });
  svg.innerHTML = parts.join('') + labelBoxes.join('');
}

function legendHtml(model) {
  const kinds = [...new Set(model.components.map((c) => c.kind))];
  return `<div class="an-legend">
    ${kinds.map((k) => `<span><i style="background:${KIND[k].color}"></i>${esc(KIND[k].label)}</span>`).join('')}
    <span class="sep"></span>
    <span><i class="dot" style="background:${STATUS_COLOR.ok}"></i>in Ordnung</span>
    <span><i class="dot" style="background:${STATUS_COLOR.warn}"></i>Hinweis</span>
    <span><svg width="26" height="8"><path d="M0 4H26" stroke="#64748b" stroke-width="2" stroke-dasharray="5 4"/></svg>noch offen / ungewiss</span>
  </div>`;
}

const HELP_YAML = `version: 1
components:
  - id: server            # Kennung (frei wählbar; gleiche Kennung wie ein erkannter Dienst, z. B. telegram, ergänzt diesen)
    kind: hosting         # dev | repo | hosting | database | storage | service | llm | mail | messaging | map | payment | other
    name: Linux-Server (Renningen)
    provider: Debian 13
    description: Läuft rund um die Uhr und führt die Aufgaben aus.
    details: { Standort: Renningen, Dienst: systemd }
  - id: telegram
    kind: messaging
    name: Telegram-Bot
    description: Nimmt Aufgaben entgegen und antwortet.
links:
  - from: server
    to: telegram
    label: Nachrichten
    description: Der Server fragt die Telegram Bot API ab.`;

function showHelp() {
  openModal(`
    <h2>So entsteht die Architektur-Karte</h2>
    <ol class="text-sm">
      <li><strong>Automatisch (Programm):</strong> DevDeck liest Maschinen, Workspaces, GitHub-Repository, die Namen der Secrets/<code>.env</code>-Variablen
        (z. B. <code>TELEGRAM_*</code>, <code>IMAP_HOST</code>, <code>ANTHROPIC_*</code>), Hostnamen ohne Zugangsdaten, Abhängigkeiten, <code>vercel.json</code>/Dockerfile/systemd-Dateien
        und lokale SQLite-Dateien (mit Größe). Aktualisiert wird bei jeder Prüfung/Sync eines Workspaces.</li>
      <li><strong>Manifest (versioniert, empfohlen):</strong> Beschreibungen, Beziehungen und alles, was sich nicht erkennen lässt, stehen in
        <code>.devdeck/architecture.yaml</code> im Repository. <strong>Claude Code pflegt die Datei bei jeder Änderung mit</strong> (Regel in <code>.claude/rules/devdeck.md</code>).</li>
      <li><strong>Manuell:</strong> Klick auf eine Karte → bearbeiten, ausblenden oder zurücksetzen; „+ Komponente“ und „+ Beziehung“ ergänzen Eigenes.
        Manuelle Anpassungen haben Vorrang vor Manifest und Automatik.</li>
    </ol>
    <p class="text-sm muted">Beispiel für <code>.devdeck/architecture.yaml</code>:</p>
    <pre class="secret-value" style="white-space:pre-wrap;font-size:12px">${esc(HELP_YAML)}</pre>
    <div class="modal-actions"><button class="btn" id="an-help-close" type="button">Schließen</button></div>`,
  (root) => $('#an-help-close', root).addEventListener('click', closeModal));
}

const detailsToText = (d) => d.map((x) => `${x.label}: ${x.value}`).join('\n');
const textToDetails = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const i = l.indexOf(':');
  return i > 0 ? { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : { label: 'Info', value: l };
});

function editForm({ title, comp }) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(title)}</h2>
      <form id="an-form" class="stack">
        <label>Name <input name="name" required value="${esc(comp?.name ?? '')}" /></label>
        <label>Typ <select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${k === (comp?.kind ?? 'service') ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label>Anbieter / Technik <input name="provider" value="${esc(comp?.provider ?? '')}" placeholder="z. B. Supabase, IONOS, Debian 13" /></label>
        <label>Beschreibung <textarea name="description" rows="3">${esc(comp?.description ?? '')}</textarea></label>
        <label>Details (eine Zeile je „Name: Wert“) <textarea name="details" rows="4">${esc(detailsToText(comp?.details ?? []))}</textarea></label>
        <p class="error" id="an-error"></p>
        <div class="modal-actions"><button class="btn ghost" type="button" id="an-cancel">Abbrechen</button><button class="btn" type="submit">Speichern</button></div>
      </form>`, (root) => {
      $('#an-cancel', root).addEventListener('click', () => { closeModal(); resolve(null); });
      $('#an-form', root).addEventListener('submit', (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        resolve({ data: { name: f.name, kind: f.kind, provider: f.provider || null, description: f.description || null, details: textToDetails(f.details) }, root });
      });
    });
  });
}

function linkForm(model) {
  return new Promise((resolve) => {
    const opts = model.components.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join('');
    openModal(`
      <h2>Beziehung hinzufügen</h2>
      <form id="an-form" class="stack">
        <label>Von <select name="from">${opts}</select></label>
        <label>Nach <select name="to">${opts}</select></label>
        <label>Beschriftung <input name="label" required placeholder="z. B. liest / schreibt" /></label>
        <label>Beschreibung (optional) <textarea name="description" rows="2"></textarea></label>
        <p class="error" id="an-error"></p>
        <div class="modal-actions"><button class="btn ghost" type="button" id="an-cancel">Abbrechen</button><button class="btn" type="submit">Hinzufügen</button></div>
      </form>`, (root) => {
      $('#an-cancel', root).addEventListener('click', () => { closeModal(); resolve(null); });
      $('#an-form', root).addEventListener('submit', (e) => {
        e.preventDefault();
        resolve({ data: Object.fromEntries(new FormData(e.target)), root });
      });
    });
  });
}

export async function renderArchitecture(host, project) {
  const canEdit = roleAtLeast(project.role, 'maintainer');
  const base = `/api/projects/${project.id}/architecture`;
  host.innerHTML = '<div class="arch-card"><div class="an-loading">Architektur wird geladen …</div></div>';
  let model;
  try { model = await get(base); } catch (err) { host.innerHTML = `<div class="arch-card"><p class="error">${esc(err.message)}</p></div>`; return; }

  const byKey = new Map(model.components.map((c) => [c.key, c]));
  host.innerHTML = `
    <div class="arch-card">
      <div class="an-top">
        <div>
          <h2>Architektur &amp; Abhängigkeiten</h2>
          <p class="an-sub">Wie die Teile dieses Projekts zusammenhängen – von der Entwicklung über GitHub und den Betrieb bis zu Datenbank und externen Diensten.
            ${model.facts_at ? `Zuletzt erkannt: ${esc(fmtDate(model.facts_at))}.` : 'Noch keine Fakten von einem Agenten – „Aktualisieren“ oder einen Workspace prüfen.'}</p>
        </div>
        <div class="an-actions">
          <button class="btn ghost sm" id="an-help" type="button">Wie wird das gepflegt?</button>
          ${roleAtLeast(project.role, 'developer') ? '<button class="btn ghost sm" id="an-refresh" type="button">Aktualisieren</button>' : ''}
          ${canEdit ? '<button class="btn ghost sm" id="an-add" type="button">+ Komponente</button><button class="btn ghost sm" id="an-add-link" type="button">+ Beziehung</button>' : ''}
        </div>
      </div>
      ${model.manifest.error ? `<p class="an-alert">⚠ ${esc(model.manifest.error)}</p>` : ''}
      ${!model.manifest.present && !model.manifest.error ? '<p class="an-hint">Tipp: Beschreibungen und Beziehungen stehen am besten in <code>.devdeck/architecture.yaml</code> im Repository – Claude Code pflegt die Datei dank der DevDeck-Regeln mit. Format: „Wie wird das gepflegt?“.</p>' : ''}
      <div class="an-scroll"><div class="an-stage">
        ${model.components.length ? model.components.map(nodeHtml).join('') : '<div class="an-empty">Noch nichts erkannt. Registriere einen Workspace und prüfe ihn, oder füge Komponenten manuell hinzu.</div>'}
        <svg class="an-edges" xmlns="http://www.w3.org/2000/svg"></svg>
      </div></div>
      ${legendHtml(model)}
      ${canEdit && (model.hidden.components.length || model.hidden.links.length) ? `<p class="an-hint"><a href="#" id="an-restore">${model.hidden.components.length + model.hidden.links.length} ausgeblendete Element(e) anzeigen / wiederherstellen</a></p>` : ''}
    </div>`;

  const stage = $('.an-stage', host);
  const draw = () => { if (model.components.length) layout(stage, model); };
  draw();
  const onResize = () => { if (document.body.contains(stage)) draw(); else window.removeEventListener('resize', onResize); };
  window.addEventListener('resize', onResize);

  const reload = () => renderArchitecture(host, project);

  $('#an-help', host).addEventListener('click', showHelp);
  $('#an-refresh', host)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await post(`${base}/refresh`);
      toast(r.requested ? `Prüfung bei ${r.requested} Workspace(s) beauftragt – Ergebnis in wenigen Sekunden` : 'Keine online befindliche Maschine zum Prüfen', r.requested ? 'success' : 'info');
      if (r.requested) setTimeout(reload, 8000);
    } catch (err) { toast(err.message, 'error'); }
    e.target.disabled = false;
  });
  $('#an-add', host)?.addEventListener('click', async () => {
    const res = await editForm({ title: 'Komponente hinzufügen', comp: null });
    if (!res) return;
    try { await post(`${base}/components`, res.data); closeModal(); toast('Komponente hinzugefügt', 'success'); reload(); }
    catch (err) { $('#an-error', res.root).textContent = err.message; }
  });
  $('#an-add-link', host)?.addEventListener('click', async () => {
    const res = await linkForm(model);
    if (!res) return;
    try { await post(`${base}/links`, res.data); closeModal(); toast('Beziehung hinzugefügt', 'success'); reload(); }
    catch (err) { $('#an-error', res.root).textContent = err.message; }
  });

  $('#an-restore', host)?.addEventListener('click', (e) => {
    e.preventDefault();
    const items = [
      ...model.hidden.components.map((c) => ({ label: `Komponente: ${c.name}`, body: { type: 'component', key: c.key } })),
      ...model.hidden.links.map((l) => ({ label: `Beziehung: ${l.from} → ${l.to} (${l.label})`, body: { type: 'link', ...l } })),
    ];
    openModal(`<h2>Ausgeblendet</h2><ul class="text-sm">${items.map((it, i) => `<li>${esc(it.label)} <button class="btn ghost sm" data-i="${i}" type="button">Wiederherstellen</button></li>`).join('')}</ul>
      <div class="modal-actions"><button class="btn" id="an-close2" type="button">Schließen</button></div>`, (root) => {
      $('#an-close2', root).addEventListener('click', closeModal);
      $$('[data-i]', root).forEach((b) => b.addEventListener('click', async () => {
        try { await post(`${base}/restore`, items[Number(b.dataset.i)].body); closeModal(); toast('Wiederhergestellt', 'success'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      }));
    });
  });

  const showNode = (key) => {
    const c = byKey.get(key);
    const k = KIND[c.kind] ?? KIND.other;
    const rel = model.links.filter((l) => l.from === key || l.to === key).map((l) => {
      const other = byKey.get(l.from === key ? l.to : l.from);
      return `<li>${l.from === key ? '→' : '←'} <strong>${esc(other?.name ?? '?')}</strong>: ${esc(l.label)}${l.description ? `<br><span class="muted">${esc(l.description)}</span>` : ''}</li>`;
    }).join('');
    openModal(`
      <h2>${esc(c.name)}</h2>
      <p class="text-sm"><span class="badge" style="background:${k.color};color:#fff">${esc(k.label)}</span> ${c.provider ? esc(c.provider) : ''}
        <span class="muted"> · ${esc(SOURCE_LABEL[c.source])}</span></p>
      ${c.description ? `<p class="text-sm">${esc(c.description)}</p>` : ''}
      ${c.details.length ? `<table><tbody>${c.details.map((d) => `<tr><td class="muted text-sm">${esc(d.label)}</td><td class="text-sm">${esc(d.value)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${rel ? `<p class="text-sm muted" style="margin-top:var(--space-3)">Beziehungen</p><ul class="text-sm">${rel}</ul>` : ''}
      <div class="modal-actions">
        ${canEdit ? `<button class="btn ghost" id="an-hide" type="button">Ausblenden</button>${c.source === 'manual' ? '<button class="btn ghost" id="an-reset" type="button">Zurücksetzen</button>' : ''}<button class="btn" id="an-edit" type="button">Bearbeiten</button>` : ''}
        <button class="btn ghost" id="an-close" type="button">Schließen</button>
      </div>`, (root) => {
      $('#an-close', root).addEventListener('click', closeModal);
      const enc = encodeURIComponent(key);
      $('#an-edit', root)?.addEventListener('click', async () => {
        closeModal();
        const res = await editForm({ title: `${c.name} bearbeiten`, comp: c });
        if (!res) return;
        try { await put(`${base}/components/${enc}`, res.data); closeModal(); toast('Gespeichert', 'success'); reload(); }
        catch (err) { $('#an-error', res.root).textContent = err.message; }
      });
      $('#an-hide', root)?.addEventListener('click', async () => {
        try { await put(`${base}/components/${enc}`, { hidden: true }); closeModal(); toast('Ausgeblendet – unter dem Diagramm wiederherstellbar', 'success'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
      $('#an-reset', root)?.addEventListener('click', async () => {
        try { await del(`${base}/components/${enc}`); closeModal(); toast('Zurückgesetzt', 'success'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  };
  $$('.an-node', host).forEach((n) => {
    n.addEventListener('click', () => showNode(n.dataset.key));
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showNode(n.dataset.key); } });
  });
  $$('.an-label', host).forEach((g) => g.addEventListener('click', async () => {
    const l = model.links[Number(g.dataset.link)];
    const a = byKey.get(l.from)?.name;
    const b = byKey.get(l.to)?.name;
    if (!canEdit) { toast(`${a} → ${b}: ${l.label}${l.description ? ` – ${l.description}` : ''}`, 'info'); return; }
    const ok = await confirmModal({
      title: `${a} → ${b}`,
      message: `${l.label}${l.description ? ` – ${l.description}` : ''} (${SOURCE_LABEL[l.source]}). Diese Beziehung ausblenden bzw. löschen?`,
      confirmLabel: 'Entfernen',
    });
    if (!ok) return;
    try { await del(`${base}/links`, { from: l.from, to: l.to, label: l.label }); toast('Beziehung entfernt', 'success'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  }));
}
