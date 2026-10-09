import { get, post } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, setModalError, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { state } from '../../lib/api.js';
import { icon } from '../../lib/icons.js';

function linesToArray(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function renderSessions(el, project) {
  const [sessions, handovers] = await Promise.all([
    get(`/api/projects/${project.id}/sessions`),
    get(`/api/projects/${project.id}/handovers`).catch(() => []),
  ]);
  const canStart = roleAtLeast(project.role, 'developer');

  const handoverBySession = new Map(handovers.map((h) => [h.session_id, h]));

  const rows = sessions.map((s) => {
    const mine = s.user_id === state.user.id;
    const canFinish = mine || roleAtLeast(project.role, 'maintainer');
    const hasHandover = handoverBySession.has(s.id);
    return `
    <tr>
      <td>
        <strong>${esc(s.goal || '(ohne Ziel)')}</strong><br>
        <span class="muted text-sm">${esc(s.user_email || '')} ${s.agent_name ? `· ${esc(s.agent_name)}` : ''}</span>
      </td>
      <td>${badge(s.status === 'open' ? 'läuft' : 'beendet', s.status === 'open' ? 'warn' : 'ok')}</td>
      <td class="muted text-sm">${fmtDate(s.started_at)}</td>
      <td class="muted text-sm">${s.ended_at ? fmtDate(s.ended_at) : '–'}</td>
      <td class="actions">
        ${s.status === 'open' && canFinish ? `<button class="btn ghost sm" data-finish="${s.id}">Beenden</button>` : ''}
        ${mine && !hasHandover ? `<button class="btn subtle sm" data-handover="${s.id}">Handover</button>` : ''}
        ${hasHandover ? `<span class="badge ok">${icon('check', { size: 13 })}Handover</span>` : ''}
      </td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Coding Sessions</h2>
        ${canStart ? '<button class="btn sm" id="btn-new-session">' + icon('plus') + 'Session starten</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Ziel</th><th>Status</th><th>Start</th><th>Ende</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5"><div class="empty-state"><div class="icon">' + icon('code', { size: 32 }) + '</div>Noch keine Coding Sessions.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-session', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Coding Session starten',
      submitLabel: 'Starten',
      bodyHtml: `
        <label>Ziel der Session <input name="goal" required placeholder="z. B. Login-Bug beheben" /></label>
        <label>Agent (optional) <input name="agent_name" placeholder="claude / codex" /></label>`,
    });
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/sessions`, res.data);
      closeModal();
      toast('Session gestartet', 'success');
      renderSessions(el, project);
    } catch (err) { setModalError(res.root, err.message); }
  });

  for (const btn of $$('[data-finish]', el)) {
    btn.addEventListener('click', async () => {
      try {
        await post(`/api/projects/${project.id}/sessions/${btn.dataset.finish}/complete`);
        toast('Session beendet', 'success');
        renderSessions(el, project);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  for (const btn of $$('[data-handover]', el)) {
    btn.addEventListener('click', async () => {
      const sessionId = btn.dataset.handover;
      const res = await formModal({
        title: 'Handover erstellen',
        submitLabel: 'Übergeben',
        bodyHtml: `
          <label>Erledigt (eine Zeile je Punkt) <textarea name="completed" rows="3"></textarea></label>
          <label>Offene Punkte (eine Zeile je Punkt) <textarea name="open_items" rows="3"></textarea></label>
          <label>Geänderte Dateien (eine Zeile je Datei) <textarea name="changed_files" rows="2"></textarea></label>
          <label>Notizen <textarea name="notes" rows="3"></textarea></label>`,
      });
      if (!res) return;
      const payload = {
        completed: linesToArray(res.data.completed),
        open_items: linesToArray(res.data.open_items),
        changed_files: linesToArray(res.data.changed_files),
        notes: res.data.notes || '',
      };
      try {
        await post(`/api/projects/${project.id}/sessions/${sessionId}/handover`, { payload: JSON.stringify(payload) });
        closeModal();
        toast('Handover gespeichert', 'success');
        renderSessions(el, project);
      } catch (err) { setModalError(res.root, err.message); }
    });
  }
}
