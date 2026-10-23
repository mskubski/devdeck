import { get, post, patch } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, setModalError, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

const DECISION_LABEL = { proposed: 'vorgeschlagen', accepted: 'akzeptiert', superseded: 'abgelöst', rejected: 'abgelehnt' };
const SEVERITY_LABEL = { low: 'niedrig', medium: 'mittel', high: 'hoch' };
const HISTORY_LABEL = {
  changelog: 'Changelog', decision: 'Entscheidung', known_issue: 'Known Issue', known_issue_resolved: 'Issue gelöst',
  task: 'Task', task_done: 'Task erledigt', session: 'Session',
};

export async function renderDecisions(el, project) {
  const items = await get(`/api/projects/${project.id}/decisions`);
  const canWrite = roleAtLeast(project.role, 'developer');
  const canDecide = roleAtLeast(project.role, 'maintainer');
  const rows = items.map((d) => `
    <tr>
      <td><strong>${esc(d.title)}</strong>
        ${d.rationale ? `<br><span class="muted text-sm">${esc(d.rationale)}</span>` : ''}
        ${d.alternative ? `<br><span class="muted text-sm">Alternative: ${esc(d.alternative)}</span>` : ''}</td>
      <td>${badge(DECISION_LABEL[d.status] ?? d.status, d.status === 'accepted' ? 'ok' : d.status === 'rejected' ? 'bad' : 'warn')}</td>
      <td class="muted text-sm">${fmtDate(d.decided_at ?? d.created_at)}</td>
      <td class="actions">${canDecide && d.status === 'proposed' ? `
        <button class="btn subtle sm" data-set="${d.id}" data-status="accepted">Akzeptieren</button>
        <button class="btn ghost sm" data-set="${d.id}" data-status="rejected">Ablehnen</button>` : ''}
        ${canDecide && d.status === 'accepted' ? `<button class="btn ghost sm" data-set="${d.id}" data-status="superseded">Ablösen</button>` : ''}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Entscheidungen</h2>
        ${canWrite ? `<button class="btn sm" id="btn-new">${icon('plus')}Neue Entscheidung</button>` : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Entscheidung</th><th>Status</th><th>Datum</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4"><div class="empty-state">Keine Entscheidungen erfasst.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;
  const refresh = () => renderDecisions(el, project);
  $('#btn-new', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Neue Entscheidung', submitLabel: 'Anlegen',
      bodyHtml: `<label>Titel <input name="title" required /></label>
        <label>Begründung <textarea name="rationale" rows="3"></textarea></label>
        <label>Kontext <textarea name="context" rows="2"></textarea></label>
        <label>Verworfene Alternative <input name="alternative" /></label>`,
    });
    if (!res) return;
    try { await post(`/api/projects/${project.id}/decisions`, res.data); closeModal(); toast('Entscheidung angelegt', 'success'); refresh(); }
    catch (err) { setModalError(res.root, err.message); }
  });
  for (const btn of $$('[data-set]', el)) {
    btn.addEventListener('click', async () => {
      try { await patch(`/api/projects/${project.id}/decisions/${btn.dataset.set}`, { status: btn.dataset.status }); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
}

export async function renderChangelog(el, project) {
  const items = await get(`/api/projects/${project.id}/changelog`);
  const canWrite = roleAtLeast(project.role, 'developer');
  const rows = items.map((c) => `
    <tr>
      <td class="muted text-sm">${fmtDate(c.created_at)}</td>
      <td class="mono text-sm">${esc(c.version || '–')}</td>
      <td><strong>${esc(c.summary)}</strong>${c.body ? `<br><span class="muted text-sm">${esc(c.body)}</span>` : ''}</td>
      <td class="muted text-sm">${esc(c.source)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Changelog</h2>
        ${canWrite ? `<button class="btn sm" id="btn-new">${icon('plus')}Eintrag hinzufügen</button>` : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Datum</th><th>Version</th><th>Änderung</th><th>Quelle</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4"><div class="empty-state">Noch keine Einträge.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;
  $('#btn-new', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Changelog-Eintrag', submitLabel: 'Hinzufügen',
      bodyHtml: `<label>Zusammenfassung <input name="summary" required /></label>
        <label>Version (optional) <input name="version" placeholder="1.2.0" /></label>
        <label>Details <textarea name="body" rows="3"></textarea></label>`,
    });
    if (!res) return;
    try { await post(`/api/projects/${project.id}/changelog`, res.data); closeModal(); toast('Eintrag hinzugefügt', 'success'); renderChangelog(el, project); }
    catch (err) { setModalError(res.root, err.message); }
  });
}

export async function renderKnownIssues(el, project) {
  const items = await get(`/api/projects/${project.id}/known-issues`);
  const canWrite = roleAtLeast(project.role, 'developer');
  const rows = items.map((i) => `
    <tr>
      <td><strong>${esc(i.title)}</strong>${i.description ? `<br><span class="muted text-sm">${esc(i.description)}</span>` : ''}</td>
      <td>${badge(SEVERITY_LABEL[i.severity] ?? i.severity, i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : '')}</td>
      <td>${badge(i.status === 'open' ? 'offen' : 'gelöst', i.status === 'open' ? 'warn' : 'ok')}</td>
      <td class="muted text-sm">${fmtDate(i.created_at)}</td>
      <td class="actions">${canWrite ? `<button class="btn ghost sm" data-toggle="${i.id}" data-status="${i.status === 'open' ? 'resolved' : 'open'}">${i.status === 'open' ? 'Als gelöst markieren' : 'Wieder öffnen'}</button>` : ''}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Known Issues</h2>
        ${canWrite ? `<button class="btn sm" id="btn-new">${icon('plus')}Neues Problem</button>` : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Problem</th><th>Schwere</th><th>Status</th><th>Erfasst</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5"><div class="empty-state">Keine bekannten Probleme.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;
  const refresh = () => renderKnownIssues(el, project);
  $('#btn-new', el)?.addEventListener('click', async () => {
    const res = await formModal({
      title: 'Neues bekanntes Problem', submitLabel: 'Anlegen',
      bodyHtml: `<label>Titel <input name="title" required /></label>
        <label>Beschreibung <textarea name="description" rows="3"></textarea></label>
        <label>Schwere <select name="severity"><option value="low">niedrig</option>
          <option value="medium" selected>mittel</option><option value="high">hoch</option></select></label>`,
    });
    if (!res) return;
    try { await post(`/api/projects/${project.id}/known-issues`, res.data); closeModal(); toast('Problem erfasst', 'success'); refresh(); }
    catch (err) { setModalError(res.root, err.message); }
  });
  for (const btn of $$('[data-toggle]', el)) {
    btn.addEventListener('click', async () => {
      try { await patch(`/api/projects/${project.id}/known-issues/${btn.dataset.toggle}`, { status: btn.dataset.status }); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
}

export async function renderHistory(el, project) {
  const events = await get(`/api/projects/${project.id}/history`);
  const rows = events.map((e) => `
    <tr>
      <td class="muted text-sm">${fmtDate(e.at)}</td>
      <td>${badge(HISTORY_LABEL[e.type] ?? e.type, '')}</td>
      <td>${esc(e.title)}</td>
      <td class="muted text-sm">${esc(e.actor || '')}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Verlauf</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Zeitpunkt</th><th>Art</th><th>Titel</th><th>Von</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4"><div class="empty-state">Noch keine Ereignisse.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;
}
