/* DevDeck Web UI – Einstiegspunkt: Auth, Routing, Shell (Entscheidung A8: Vanilla JS, ES-Module). */
import { api, state } from './lib/api.js';
import { $, esc, toast } from './lib/ui.js';
import { icon } from './lib/icons.js';
import { renderProjects } from './views/projects.js';
import { renderProjectDetail } from './views/projectDetail.js';
import { renderMachines } from './views/machines.js';
import { renderUsers } from './views/users.js';
import { renderAudit } from './views/audit.js';
import { renderHelp } from './views/help.js';

const NAV = [
  { hash: '#/projects', icon: 'folder', label: 'Projekte', match: (h) => h.startsWith('#/projects') },
  { hash: '#/machines', icon: 'monitor', label: 'Maschinen', match: (h) => h.startsWith('#/machines') },
  { hash: '#/users', icon: 'users', label: 'Benutzer', match: (h) => h.startsWith('#/users'), adminOnly: true },
  { hash: '#/audit', icon: 'history', label: 'Audit-Log', match: (h) => h.startsWith('#/audit') },
  { hash: '#/help', icon: 'help', label: 'Hilfe', match: (h) => h.startsWith('#/help') },
];

function currentTheme() {
  return document.documentElement.getAttribute('data-theme')
    ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

/** Theme-Button zeigt das Ziel: im Dark Mode die Sonne, im Light Mode den Mond. */
function renderThemeToggle() {
  const dark = currentTheme() === 'dark';
  $('#theme-toggle').innerHTML = `${icon(dark ? 'sun' : 'moon', { size: 16 })}<span>${dark ? 'Hell' : 'Dunkel'}</span>`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('devdeck-theme', theme);
  renderThemeToggle();
}

/** Statische Shell-Elemente aus index.html mit Icons versehen. */
function decorateShell() {
  for (const el of document.querySelectorAll('.brand .dot')) el.outerHTML = icon('layers', { size: 20, cls: 'accent' });
  $('#menu-toggle').innerHTML = icon('menu', { size: 20 });
  $('#logout').innerHTML = `${icon('logout', { size: 16 })}<span>Abmelden</span>`;
  renderThemeToggle();
}

function initTheme() {
  const saved = localStorage.getItem('devdeck-theme');
  if (saved) applyTheme(saved);
  decorateShell();
}

function renderNav() {
  const hash = location.hash || '#/projects';
  const items = NAV.filter((n) => !n.adminOnly || state.user?.system_role === 'admin');
  $('#nav').innerHTML = items.map((n) => `
    <a class="nav-item ${n.match(hash) ? 'active' : ''}" href="${n.hash}">
      ${icon(n.icon)}<span>${n.label}</span>
    </a>`).join('');
}

function setBreadcrumb(current, parent) {
  $('#breadcrumb').innerHTML = parent
    ? `<a class="link muted-crumb" href="#/projects">${esc(parent)}</a><span class="sep">/</span>${esc(current)}`
    : esc(current);
}

function showLogin(msg = '') {
  $('#view-login').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  $('#loginerror').textContent = msg;
}

function showApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  const initials = (state.user.display_name || state.user.email).slice(0, 1).toUpperCase();
  $('#userinfo').innerHTML = `
    <div class="who"><b>${esc(state.user.display_name || state.user.email)}</b>${esc(state.user.system_role)}</div>
    <div class="avatar">${esc(initials)}</div>`;
}

async function boot() {
  initTheme();
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    state.memberships = me.memberships;
    showApp();
    renderNav();
    route();
  } catch {
    showLogin();
  }
}

async function route() {
  if (!state.user) return showLogin();
  renderNav();
  const hash = (location.hash || '#/projects').replace(/^#\//, '');
  const [path, query] = hash.split('?');
  const content = $('#content');
  setBreadcrumb(NAV.find((n) => n.match(`#/${path}`))?.label ?? 'DevDeck');
  content.innerHTML = '<div class="stack"><div class="skeleton" style="width:40%"></div><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:70%"></div></div>';
  try {
    if (path.startsWith('projects/')) {
      await renderProjectDetail(content, path.slice('projects/'.length) + (query ? `?${query}` : ''), setBreadcrumb);
    } else if (path.startsWith('machines')) {
      await renderMachines(content);
    } else if (path.startsWith('users')) {
      if (state.user.system_role !== 'admin') throw Object.assign(new Error('Nur für Administratoren'), { status: 403 });
      await renderUsers(content);
    } else if (path.startsWith('audit')) {
      await renderAudit(content, query);
    } else if (path.startsWith('help')) {
      await renderHelp(content);
    } else {
      await renderProjects(content);
    }
  } catch (err) {
    content.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
  }
}

$('#loginform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
    state.user = user;
    const me = await api('/api/auth/me');
    state.memberships = me.memberships;
    showApp();
    location.hash = '#/projects';
    renderNav();
    route();
  } catch (err) {
    $('#loginerror').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  showLogin();
});

$('#theme-toggle').addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

$('#menu-toggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (e.target.closest('.nav-item')) $('#sidebar').classList.remove('open');
});

window.addEventListener('hashchange', route);
boot();
