/* DevDeck Web UI – schlanke Vanilla-JS-Oberfläche (Entscheidung A8). */
'use strict';

const state = { user: null, memberships: [] };

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body?.data;
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showLogin(msg = '') {
  $('#view-login').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  $('#nav').classList.add('hidden');
  $('#logout').classList.add('hidden');
  $('#userinfo').textContent = '';
  $('#loginerror').textContent = msg;
}

function showApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#nav').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  $('#userinfo').textContent = `${state.user.email} · ${state.user.system_role}`;
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    state.memberships = me.memberships;
    showApp();
    route();
  } catch {
    showLogin();
  }
}

async function route() {
  if (!state.user) return showLogin();
  const hash = location.hash || '#/projects';
  const content = $('#content');
  try {
    if (hash.startsWith('#/projects/')) {
      await viewProject(content, hash.slice('#/projects/'.length));
    } else if (hash.startsWith('#/machines')) {
      await viewMachines(content);
    } else if (hash.startsWith('#/audit')) {
      await viewAudit(content);
    } else {
      await viewProjects(content);
    }
  } catch (err) {
    content.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
  }
}

async function viewProjects(el) {
  const projects = await api('/api/projects');
  const rows = projects.map((p) => `
    <tr>
      <td><a class="link" href="#/projects/${esc(p.id)}">${esc(p.name)}</a></td>
      <td><span class="badge">${esc(p.role || 'member')}</span></td>
      <td class="muted">${esc(p.description || '')}</td>
      <td class="muted">${esc(p.repo_remote || '–')}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <h1>Projekte</h1>
      <table><thead><tr><th>Name</th><th>Rolle</th><th>Beschreibung</th><th>Repository</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">Keine Projekte.</td></tr>'}</tbody></table>
    </div>
    ${state.user.system_role === 'admin' ? `
    <div class="card">
      <h2>Projekt anlegen</h2>
      <form id="newproject">
        <label>Name <input name="name" required /></label>
        <label>Beschreibung <input name="description" /></label>
        <label>Git-Remote <input name="repo_remote" placeholder="https://github.com/..." /></label>
        <button class="btn" type="submit">Anlegen</button>
        <p class="error" id="nperr"></p>
      </form>
    </div>` : ''}`;
  const form = $('#newproject');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/api/projects', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(fd)),
        });
        route();
      } catch (err) { $('#nperr').textContent = err.message; }
    });
  }
}

async function viewProject(el, id) {
  const [project, members] = await Promise.all([
    api(`/api/projects/${id}`),
    api(`/api/projects/${id}/members`),
  ]);
  const memberRows = members.map((m) => `
    <tr><td>${esc(m.email)}</td><td><span class="badge">${esc(m.role)}</span></td></tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <p><a class="link" href="#/projects">← Projekte</a></p>
      <h1>${esc(project.name)} <span class="badge">${esc(project.role)}</span></h1>
      <p class="muted">${esc(project.description || '')}</p>
      <p class="muted">Repository: ${esc(project.repo_remote || '–')} · Branch: ${esc(project.default_branch)}</p>
      <div class="row">
        <a class="link" href="#/audit?project_id=${esc(project.id)}">Audit</a>
      </div>
    </div>
    <div class="card">
      <h2>Mitglieder</h2>
      <table><thead><tr><th>E-Mail</th><th>Rolle</th></tr></thead><tbody>${memberRows}</tbody></table>
    </div>
    <div class="card">
      <h2>Status</h2>
      <p class="muted">Tasks, Decisions, Changelog, Maschinen, Workspaces und Secrets erscheinen
      hier, sobald die zugehörigen Phasen aktiv sind (siehe IMPLEMENTATION_STATUS.md).</p>
    </div>`;
}

async function viewMachines(el) {
  el.innerHTML = `<div class="card"><h1>Maschinen</h1>
    <p class="muted">Machine Registry wird mit Phase B (Agent-Protokoll) verfügbar.</p></div>`;
}

async function viewAudit(el) {
  const qs = location.hash.includes('?') ? location.hash.split('?')[1] : '';
  const projectId = new URLSearchParams(qs).get('project_id');
  const path = state.user.system_role === 'admin' && !projectId
    ? '/api/audit/all'
    : `/api/audit?project_id=${encodeURIComponent(projectId || '')}`;
  const entries = await api(path);
  const rows = entries.map((a) => `
    <tr>
      <td class="muted">${esc(a.created_at)}</td>
      <td>${esc(a.action)}</td>
      <td>${esc(a.actor_label || a.actor_type)}</td>
      <td><span class="badge ${a.result === 'success' ? 'ok' : a.result === 'denied' ? 'warn' : 'bad'}">${esc(a.result)}</span></td>
      <td class="muted">${esc(a.detail_json || '')}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <h1>Audit-Log</h1>
      <table><thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Akteur</th><th>Ergebnis</th><th>Detail</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">Keine Einträge.</td></tr>'}</tbody></table>
    </div>`;
}

$('#loginform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const user = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(fd)),
    });
    state.user = user;
    const me = await api('/api/auth/me');
    state.memberships = me.memberships;
    showApp();
    location.hash = '#/projects';
    route();
  } catch (err) {
    $('#loginerror').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  showLogin();
});

window.addEventListener('hashchange', route);
boot();
