import { get, post, del } from '../lib/api.js';
import { $, $$, esc, badge, fmtDate, timeAgo, toast, formModal, confirmModal, openModal, closeModal } from '../lib/ui.js';
import { state } from '../lib/api.js';
import { roleAtLeast } from '../lib/roles.js';
import { icon } from '../lib/icons.js';

async function loadMachines() {
  if (state.user.system_role === 'admin') {
    return get('/api/machines');
  }
  const manageable = state.memberships.filter((m) => roleAtLeast(m.role, 'maintainer'));
  const lists = await Promise.all(
    manageable.map((m) => get(`/api/machines?project_id=${m.project_id}`).catch(() => [])),
  );
  const byId = new Map();
  for (const list of lists) for (const machine of list) byId.set(machine.id, machine);
  return [...byId.values()];
}

export async function renderMachines(el) {
  const canCreateToken = state.user.system_role === 'admin' || state.memberships.some((m) => roleAtLeast(m.role, 'maintainer'));
  const machines = await loadMachines();

  const rows = machines.map((m) => `
    <tr>
      <td>${esc(m.name)}</td>
      <td class="muted text-sm">${esc(m.platform)}</td>
      <td class="muted text-sm">${esc(m.agent_version || '–')}${m.agent_outdated ? ' ' + badge('veraltet', 'warn') : ''}</td>
      <td class="muted text-sm"><span class="mono">${esc(m.workspace_root || '–')}</span></td>
      <td>${badge(m.agent_status, m.agent_status)}</td>
      <td class="muted text-sm">${m.last_seen_at ? timeAgo(m.last_seen_at) : 'nie'}</td>
      <td class="actions">
        ${m.agent_status === 'online' && m.agent_outdated ? `<button class="btn ghost sm" data-howto="1">Update-Anleitung</button>` : ''}
        ${m.agent_status === 'online' && !m.agent_outdated ? `<button class="btn ghost sm" data-update="${m.id}" data-name="${esc(m.name)}">Agent updaten</button>` : ''}
        ${m.agent_status === 'online' && !m.agent_outdated ? `<button class="btn ghost sm" data-root="${m.id}" data-name="${esc(m.name)}" data-current="${esc(m.workspace_root || '')}">Root ändern</button>` : ''}
        ${m.agent_status !== 'revoked' ? `<button class="btn ghost sm" data-revoke="${m.id}" data-name="${esc(m.name)}">Widerrufen</button>` : ''}
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Maschinen</h1>
        <p class="lede">Entwicklungsrechner mit laufendem DevDeck Agent. Ein Enrollment-Token verbindet einen neuen Rechner einmalig mit DevDeck.</p>
      </div>
      ${canCreateToken ? '<div class="page-actions"><button class="btn" id="btn-new-token">' + icon('plus') + 'Enrollment-Token erzeugen</button></div>' : ''}
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Plattform</th><th>Agent-Version</th><th>Workspace-Root</th><th>Status</th><th>Zuletzt gesehen</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7"><div class="empty-state"><div class="icon">' + icon('monitor', { size: 32 }) + '</div>Noch keine Maschinen registriert.</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#btn-new-token', el)?.addEventListener('click', async () => {
    const projectOptions = state.memberships
      .filter((m) => roleAtLeast(m.role, 'maintainer'))
      .map((m) => `<option value="${esc(m.project_id)}">${esc(m.name)}</option>`).join('');
    const res = await formModal({
      title: 'Enrollment-Token erzeugen',
      submitLabel: 'Erzeugen',
      bodyHtml: `
        ${state.user.system_role === 'admin'
          ? `<label>Projekt (optional – ohne Zuordnung nur als Admin) <select name="project_id"><option value="">– ohne Projekt –</option>${projectOptions}</select></label>`
          : `<label>Projekt <select name="project_id" required>${projectOptions}</select></label>`}
        <label>Gültigkeit (Minuten) <input name="ttl_minutes" type="number" value="60" min="5" max="1440" /></label>`,
    });
    if (!res) return;
    try {
      const body = { ttl_minutes: Number(res.data.ttl_minutes) };
      if (res.data.project_id) body.project_id = res.data.project_id;
      const token = await post('/api/machines/enrollment-tokens', body);
      showTokenModal(token.token);
    } catch (err) { toast(err.message, 'error'); }
  });

  for (const btn of $$('[data-howto]', el)) {
    btn.addEventListener('click', () => openModal(`
      <h2>Agent manuell aktualisieren</h2>
      <p class="muted text-sm">Dieser Agent ist veraltet und kann sich noch nicht selbst aktualisieren. Einmalig im DevDeck-Ordner auf dieser Maschine ausführen, danach geht es per Knopfdruck:</p>
      <div class="secret-value">git pull &amp;&amp; npm install &amp;&amp; npm run build</div>
      <p class="muted text-sm">Dann den Agent neu starten (Prozess beenden und <span class="mono">node packages/agent/dist/index.js start</span> erneut ausführen).</p>
      <div class="modal-actions"><button class="btn" id="btn-close-howto" type="button">Schließen</button></div>`, (root) => {
      root.querySelector('#btn-close-howto').addEventListener('click', closeModal);
    }));
  }

  for (const btn of $$('[data-update]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Agent aktualisieren',
        message: `Auf „${btn.dataset.name}“ wird git pull (nur Fast-Forward), Build und ein Neustart des Agents ausgeführt. Fortfahren?`,
        confirmLabel: 'Updaten',
        danger: false,
      });
      if (!ok) return;
      try {
        const { command_id } = await post(`/api/machines/${btn.dataset.update}/update`, {});
        toast('Update beauftragt …', 'info');
        for (let i = 0; i < 100; i += 1) {
          await new Promise((r) => setTimeout(r, 3000));
          const cmd = await get(`/api/machines/${btn.dataset.update}/commands/${command_id}`);
          if (cmd.status === 'done') { toast('Agent aktualisiert, startet neu', 'success'); setTimeout(() => renderMachines(el), 6000); return; }
          if (cmd.status === 'failed' || cmd.status === 'expired') { toast(cmd.error || 'Update fehlgeschlagen', 'error'); return; }
        }
        toast('Agent hat noch nicht geantwortet – siehe Agent-Log', 'error');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  for (const btn of $$('[data-root]', el)) {
    btn.addEventListener('click', async () => {
      const res = await formModal({
        title: `Workspace-Root von „${btn.dataset.name}“ ändern`,
        submitLabel: 'Ändern',
        bodyHtml: `
          <label>Neuer Workspace-Root (absoluter Pfad auf der Maschine)
            <input name="workspace_root" required value="${esc(btn.dataset.current)}" placeholder="D:\\DEVDECK" />
          </label>
          <span class="muted text-sm">Nur Workspaces unterhalb dieses Verzeichnisses dürfen synchronisiert/provisioniert werden. Das Verzeichnis wird bei Bedarf angelegt. Erfordert einen aktuellen Agent.</span>`,
      });
      if (!res) return;
      try {
        const { command_id } = await post(`/api/machines/${btn.dataset.root}/workspace-root`, { workspace_root: res.data.workspace_root });
        closeModal();
        toast('Änderung beauftragt …', 'info');
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => setTimeout(r, 1500));
          const cmd = await get(`/api/machines/${btn.dataset.root}/commands/${command_id}`);
          if (cmd.status === 'done') { toast('Workspace-Root geändert', 'success'); renderMachines(el); return; }
          if (cmd.status === 'failed' || cmd.status === 'expired') { toast(cmd.error || 'Änderung fehlgeschlagen', 'error'); return; }
        }
        toast('Agent hat noch nicht geantwortet – siehe Agent-Log', 'error');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  for (const btn of $$('[data-revoke]', el)) {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Maschine widerrufen',
        message: `„${btn.dataset.name}“ verliert sofort den Zugriff, laufende Kommandos werden abgebrochen. Fortfahren?`,
        confirmLabel: 'Widerrufen',
      });
      if (!ok) return;
      try {
        await del(`/api/machines/${btn.dataset.revoke}`, { confirm: true });
        toast('Maschine widerrufen', 'success');
        renderMachines(el);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

function showTokenModal(token) {
  const cmd = `node packages/agent/dist/index.js enroll --server ${location.origin} --token ${token}`;
  openModal(`
    <h2>Enrollment-Token</h2>
    <p class="muted text-sm">Dieses Token wird nur einmal angezeigt. Im DevDeck-Repository auf dem
    Zielrechner ausführen (es gibt noch kein global installiertes <span class="mono">devdeck-agent</span>-Kommando):</p>
    <div class="secret-value">${esc(cmd)}</div>
    <p class="muted text-sm">Danach dauerhaft im Hintergrund starten: <span class="mono">node packages/agent/dist/index.js start</span></p>
    <div class="modal-actions">
      <button class="btn" id="btn-copy-token" type="button">Befehl kopieren</button>
    </div>`, (root) => {
    root.querySelector('#btn-copy-token').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        toast('Kopiert', 'success');
      } catch { toast('Kopieren nicht möglich', 'error'); }
    });
  });
}
