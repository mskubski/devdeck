// DevDeck Web UI – kleine UI-Bausteine: Escaping, Formatierung, Toasts, Modals.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDate(iso) {
  if (!iso) return '–';
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function timeAgo(iso) {
  if (!iso) return '–';
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'gerade eben';
  const min = Math.round(sec / 60);
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} Tag(en)`;
}

/** Badge-Klasse je nach semantischem Status wählen. */
export function badgeClass(kind) {
  const map = {
    ok: 'ok', ready: 'ok', online: 'ok', success: 'ok', done: 'ok', active: 'ok', closed: 'ok',
    warn: 'warn', warning: 'warn', pending: 'warn', queued: 'warn', provisioning: 'warn', in_progress: 'warn',
    bad: 'bad', blocked: 'bad', failed: 'bad', denied: 'bad', revoked: 'bad', offline: 'bad', cancelled: 'bad',
  };
  return map[String(kind).toLowerCase()] ?? '';
}

export function badge(text, kind) {
  const cls = badgeClass(kind ?? text);
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

// ---------- Toasts ----------
let toastRoot = null;
export function toast(message, variant = 'info') {
  if (!toastRoot) toastRoot = document.getElementById('toast-root');
  if (!toastRoot) return;
  const el = document.createElement('div');
  el.className = `toast ${variant === 'error' ? 'danger' : variant === 'success' ? 'ok' : ''}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- Modal ----------
let modalRoot = null;
export function closeModal() {
  if (!modalRoot) modalRoot = document.getElementById('modal-root');
  if (modalRoot) modalRoot.innerHTML = '';
}

/**
 * Modal mit beliebigem Inner-HTML öffnen. `onMount(root)` kann Listener registrieren.
 * ESC und Klick auf Backdrop schließen das Modal.
 */
export function openModal(innerHtml, onMount) {
  if (!modalRoot) modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${innerHtml}</div></div>`;
  const backdrop = $('#modal-backdrop', modalRoot);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); }
  });
  if (onMount) onMount($('.modal', modalRoot));
}

/** Bestätigungsdialog für destruktive Aktionen (Server erwartet `confirm:true`). */
export function confirmModal({ title, message, confirmLabel = 'Bestätigen', danger = true }) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel" type="button">Abbrechen</button>
        <button class="btn ${danger ? 'danger' : ''}" id="modal-confirm" type="button">${esc(confirmLabel)}</button>
      </div>
    `, (root) => {
      $('#modal-cancel', root).addEventListener('click', () => { closeModal(); resolve(false); });
      $('#modal-confirm', root).addEventListener('click', () => { closeModal(); resolve(true); });
    });
  });
}

/** Generisches Form-Modal: Felder als HTML übergeben, Promise liefert FormData-Objekt oder null. */
export function formModal({ title, bodyHtml, submitLabel = 'Speichern' }) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(title)}</h2>
      <form id="modal-form" class="stack">
        ${bodyHtml}
        <p class="error" id="modal-error"></p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" id="modal-cancel">Abbrechen</button>
          <button class="btn" type="submit">${esc(submitLabel)}</button>
        </div>
      </form>
    `, (root) => {
      const form = $('#modal-form', root);
      $('#modal-cancel', root).addEventListener('click', () => { closeModal(); resolve(null); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        resolve({ data: Object.fromEntries(new FormData(form)), form, root });
      });
    });
  });
}

export function setModalError(root, message) {
  const el = $('#modal-error', root);
  if (el) el.textContent = message;
}
