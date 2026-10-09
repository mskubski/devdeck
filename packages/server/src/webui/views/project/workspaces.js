import { get, post } from '../../lib/api.js';
import { $, $$, esc, badge, fmtDate, toast, formModal, setModalError, confirmModal, closeModal } from '../../lib/ui.js';
import { roleAtLeast } from '../../lib/roles.js';
import { icon } from '../../lib/icons.js';

export async function renderWorkspaces(el, project) {
  const [workspaces, machines] = await Promise.all([
    get(`/api/projects/${project.id}/workspaces`),
    get(`/api/machines?project_id=${project.id}`).catch(() => []),
  ]);
  const canManage = roleAtLeast(project.role, 'developer');
  const machineName = new Map(machines.map((m) => [m.id, m.name]));

  const rows = workspaces.map((w) => `
    <tr>
      <td><span class="mono text-sm">${esc(w.local_path)}</span></td>
      <td class="muted text-sm">${esc(w.machine_id ? (machineName.get(w.machine_id) || w.machine_id) : '–')}</td>
      <td class="muted text-sm">${esc(w.branch || '–')}</td>
      <td>${badge(w.status, w.status)}</td>
      <td class="muted text-sm">${w.last_sync_at ? fmtDate(w.last_sync_at) : 'nie'}</td>
      <td class="actions">
        ${canManage ? `
          <button class="btn ghost sm" data-sync="${w.id}">Sync</button>
          <button class="btn ghost sm" data-provision="${w.id}">Provision</button>` : ''}
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="alert info">${icon('info')}<span>Sync/Provision werden als Kommando an den DevDeck Agent der zugeordneten Maschine zugestellt (Long-Poll). Die Maschine muss online sein.</span></div>
    <div class="card">
      <div class="card-head">
        <h2>Workspaces</h2>
        ${canManage ? '<button class="btn sm" id="btn-new-workspace">' + icon('plus') + 'Workspace registrieren</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Pfad</th><th>Maschine</th><th>Branch</th><th>Status</th><th>Letzter Sync</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty-state"><div class="icon">' + icon('laptop', { size: 32 }) + '</div>Noch keine Workspaces registriert.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-workspace', el)?.addEventListener('click', async () => {
    const machineOptions = machines.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    const res = await formModal({
      title: 'Workspace registrieren',
      submitLabel: 'Registrieren',
      bodyHtml: `
        <label>Lokaler Pfad <input name="local_path" required placeholder="/home/alice/Development/WebApp" /></label>
        <label>Branch <input name="branch" placeholder="main" /></label>
        <label>Maschine
          <select name="machine_id"><option value="">– später zuordnen –</option>${machineOptions}</select>
        </label>`,
    });
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/workspaces`, {
        ...res.data,
        machine_id: res.data.machine_id || undefined,
      });
      closeModal();
      toast('Workspace registriert', 'success');
      renderWorkspaces(el, project);
    } catch (err) { setModalError(res.root, err.message); }
  });

  for (const btn of $$('[data-sync]', el)) {
    btn.addEventListener('click', async () => {
      try {
        await post(`/api/workspaces/${btn.dataset.sync}/sync`);
        toast('Sync beauftragt – der Agent führt dies asynchron aus', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  for (const btn of $$('[data-provision]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Workspace provisionieren',
        message: 'Provisioniert den Workspace vollständig (Clone/Toolchain/Dependencies/Secrets/Context). Bei bereits vorhandenen, abweichenden Inhalten bricht der Agent sicherheitshalber ab.',
        confirmLabel: 'Provisionieren',
        danger: false,
      });
      if (!ok) return;
      try {
        await post(`/api/workspaces/${btn.dataset.provision}/provision`, { confirm: true });
        toast('Provisioning beauftragt', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}
