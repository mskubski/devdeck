import { esc, openModal, closeModal, toast, $, $$ } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { OS_LIST, DEFAULT_BRANCH, DEFAULT_REPO, defaultsFor, guessOs, installCommands, installScript, validateInstall } from '../lib/installScripts.js';

/** Nach dem Erzeugen eines Enrollment-Tokens: Betriebssystem wählen, Skript herunterladen oder Befehle kopieren. */
export function showInstallModal(token) {
  const form = { os: guessOs(navigator.platform), name: '', installPath: '', workspaceRoot: '', autostart: true, branch: DEFAULT_BRANCH, repo: DEFAULT_REPO };
  const current = () => ({ ...form, server: location.origin, token });

  openModal(`
    <h2>Agent auf einer Maschine installieren</h2>
    <p class="muted text-sm">Das Token wird nur einmal angezeigt und läuft ab. Wähle das Betriebssystem der neuen Maschine: Das <strong>Skript</strong> fragt Installationsordner, Workspace-Root, Maschinenname und Autostart ab und erledigt alles bis zum laufenden Agent.
    Oder du kopierst die <strong>Befehle</strong> und führst sie selbst aus.</p>
    <div class="seg" id="inst-os" role="tablist" aria-label="Betriebssystem">
      ${OS_LIST.map((o) => `<button type="button" class="seg-btn" role="tab" data-os="${o.key}">${esc(o.label)}</button>`).join('')}
    </div>
    <div class="inst-grid">
      <label>Installationsordner <input id="inst-path" autocomplete="off" /></label>
      <label>Workspace-Root <input id="inst-ws" autocomplete="off" /></label>
      <label>Maschinenname <input id="inst-name" autocomplete="off" placeholder="Computername" /></label>
      <label class="toggle inst-toggle"><input type="checkbox" role="switch" id="inst-auto" checked><span class="track"></span>Agent beim Start automatisch starten</label>
    </div>
    <p class="error" id="inst-error"></p>
    <div class="row" style="gap:var(--space-2);flex-wrap:wrap;margin:var(--space-3) 0">
      <button class="btn" id="inst-download" type="button">${icon('download', { size: 16 })}<span>Skript herunterladen</span></button>
      <button class="btn ghost" id="inst-copy" type="button"><span>Befehle kopieren</span></button>
    </div>
    <p class="muted text-sm" id="inst-hint"></p>
    <div class="secret-value inst-cmds" id="inst-cmds"></div>
    <details class="muted text-sm" style="margin-top:var(--space-3)">
      <summary>Weitere Einstellungen</summary>
      <div class="inst-grid" style="margin-top:var(--space-2)">
        <label>Repository <input id="inst-repo" autocomplete="off" /></label>
        <label>Branch <input id="inst-branch" autocomplete="off" /></label>
      </div>
    </details>
    <div class="modal-actions"><button class="btn ghost" id="inst-close" type="button">Schließen</button></div>`, (root) => {
    const q = (sel) => root.querySelector(sel);
    const sync = () => {
      for (const b of $$('.seg-btn', root)) {
        const on = b.dataset.os === form.os;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      }
      const d = defaultsFor(form.os);
      q('#inst-path').placeholder = d.install.replace('$HOME', form.os === 'windows' ? '%USERPROFILE%' : '~');
      q('#inst-ws').placeholder = d.workspace.replace('$HOME', form.os === 'windows' ? '%USERPROFILE%' : '~');
      const err = validateInstall(current());
      q('#inst-error').textContent = err ?? '';
      q('#inst-cmds').textContent = err ? '' : installCommands(form.os, current());
      q('#inst-download').disabled = Boolean(err);
      q('#inst-copy').disabled = Boolean(err);
      q('#inst-hint').textContent = form.os === 'windows'
        ? 'Windows: in PowerShell ausführen, das Skript mit  powershell -ExecutionPolicy Bypass -File .\\install-devdeck-agent.ps1 . Voraussetzung: Git und Node.js ab 22.5 (das Skript bietet die Installation per winget an).'
        : `${form.os === 'macos' ? 'macOS' : 'Linux'}: im Terminal mit  bash install-devdeck-agent.sh . Voraussetzung: git und Node.js ab 22.5.`;
    };
    for (const b of $$('.seg-btn', root)) b.addEventListener('click', () => { form.os = b.dataset.os; sync(); });
    q('#inst-path').addEventListener('input', (e) => { form.installPath = e.target.value; sync(); });
    q('#inst-ws').addEventListener('input', (e) => { form.workspaceRoot = e.target.value; sync(); });
    q('#inst-name').addEventListener('input', (e) => { form.name = e.target.value; sync(); });
    q('#inst-auto').addEventListener('change', (e) => { form.autostart = e.target.checked; sync(); });
    q('#inst-repo').value = form.repo;
    q('#inst-branch').value = form.branch;
    q('#inst-repo').addEventListener('input', (e) => { form.repo = e.target.value.trim() || DEFAULT_REPO; sync(); });
    q('#inst-branch').addEventListener('input', (e) => { form.branch = e.target.value.trim() || DEFAULT_BRANCH; sync(); });
    q('#inst-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(installCommands(form.os, current()));
        toast('Befehle kopiert', 'success');
      } catch { toast('Kopieren nicht möglich', 'error'); }
    });
    q('#inst-download').addEventListener('click', () => {
      const s = installScript(form.os, current());
      const url = URL.createObjectURL(new Blob([s.content], { type: `${s.mime};charset=utf-8` }));
      const a = document.createElement('a');
      a.href = url;
      a.download = s.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`${s.filename} heruntergeladen – enthält das einmalige Token, nach der Installation löschen`, 'info');
    });
    q('#inst-close').addEventListener('click', closeModal);
    sync();
  });
}
