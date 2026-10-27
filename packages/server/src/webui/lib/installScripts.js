/**
 * Installationsskripte und Befehle für den DevDeck Agent (Windows, Linux, macOS).
 * Reine Funktionen ohne DOM-Zugriff: Token und Einstellungen werden im Browser eingesetzt und nirgends gespeichert.
 */

export const OS_LIST = [
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
  { key: 'macos', label: 'macOS' },
];

export const DEFAULT_REPO = 'https://github.com/mskubski/devdeck.git';
export const DEFAULT_BRANCH = 'main';

/** Ausdruck für den Standardwert, wenn das Feld leer bleibt (wird erst auf der Maschine ausgewertet). */
const DEFAULTS = {
  windows: { install: '$HOME\\devdeck', workspace: '$HOME\\Development' },
  linux: { install: '$HOME/devdeck', workspace: '$HOME/Development' },
  macos: { install: '$HOME/devdeck', workspace: '$HOME/Development' },
};

export function defaultsFor(os) {
  return DEFAULTS[os] ?? DEFAULTS.linux;
}

/** Eingaben prüfen; liefert eine Fehlermeldung oder null. Verboten sind Zeichen, die in Skripten Befehle einschleusen könnten. */
export function validateInstall(o) {
  if (!/^https?:\/\/[^\s'"`$\\]+$/.test(o.server ?? '')) return 'Server-Adresse ungültig (http:// oder https://…)';
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(o.token ?? '')) return 'Enrollment-Token ungültig';
  if (o.name && !/^[A-Za-z0-9._ -]{1,60}$/.test(o.name)) return 'Maschinenname: nur Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich (höchstens 60 Zeichen)';
  for (const [label, v] of [['Installationsordner', o.installPath], ['Workspace-Root', o.workspaceRoot]]) {
    if (v && /['"`$\r\n%]/.test(v)) return `${label}: Sonderzeichen ' " \` $ % sind nicht erlaubt`;
  }
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(o.branch || DEFAULT_BRANCH)) return 'Branch ungültig';
  if (!/^https:\/\/[^\s'"`$\\]+$/.test(o.repo || DEFAULT_REPO)) return 'Repository-Adresse ungültig (https://…)';
  return null;
}

const ps = (v) => `'${String(v).replace(/'/g, "''")}'`; // PowerShell: einfache Anführungszeichen verdoppeln
const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`; // POSIX-Shell

const norm = (o) => ({
  server: o.server.replace(/\/+$/, ''),
  token: o.token,
  name: (o.name || '').trim(),
  installPath: (o.installPath || '').trim(),
  workspaceRoot: (o.workspaceRoot || '').trim(),
  autostart: o.autostart !== false,
  branch: o.branch || DEFAULT_BRANCH,
  repo: o.repo || DEFAULT_REPO,
});

const AGENT_JS_WIN = 'packages\\agent\\dist\\index.js';
const AGENT_JS = 'packages/agent/dist/index.js';

// ───────────────────────────── Befehle zum Kopieren ─────────────────────────────

/** Schritt für Schritt ohne Rückfragen – die Werte aus dem Formular sind fest eingesetzt. */
export function installCommands(os, raw) {
  const o = norm(raw);
  const d = defaultsFor(os);
  if (os === 'windows') {
    const dir = o.installPath ? ps(o.installPath) : `"${d.install}"`;
    const ws = o.workspaceRoot ? ps(o.workspaceRoot) : `"${d.workspace}"`;
    const name = o.name ? ` --name ${ps(o.name)}` : '';
    return [
      '# Voraussetzungen: Git und Node.js ab 22.5 (z. B. winget install Git.Git OpenJS.NodeJS.LTS), danach neue PowerShell öffnen',
      `git clone --branch ${ps(o.branch)} ${ps(o.repo)} ${dir}`,
      `Set-Location ${dir}`,
      'npm ci --no-audit --no-fund',
      'npm run build',
      `node ${AGENT_JS_WIN} enroll --server ${ps(o.server)} --token ${ps(o.token)}${name} --workspace-root ${ws}`,
      ...(o.autostart ? [`node ${AGENT_JS_WIN} autostart on`] : []),
      `node ${AGENT_JS_WIN} start-background`,
    ].join('\n');
  }
  const dir = o.installPath ? sh(o.installPath) : `"${d.install}"`;
  const ws = o.workspaceRoot ? sh(o.workspaceRoot) : `"${d.workspace}"`;
  const name = o.name ? ` --name ${sh(o.name)}` : '';
  return [
    `# Voraussetzungen: git und Node.js ab 22.5${os === 'macos' ? ' (z. B. brew install git node)' : ''}`,
    `git clone --branch ${sh(o.branch)} ${sh(o.repo)} ${dir}`,
    `cd ${dir}`,
    'npm ci --no-audit --no-fund && npm run build',
    `node ${AGENT_JS} enroll --server ${sh(o.server)} --token ${sh(o.token)}${name} --workspace-root ${ws}`,
    ...(o.autostart ? [`node ${AGENT_JS} autostart on`] : []),
    `node ${AGENT_JS} start-background`,
  ].join('\n');
}

// ───────────────────────────── Skript mit Rückfragen ─────────────────────────────

function windowsScript(o) {
  const d = defaultsFor('windows');
  return `# DevDeck Agent – Installation (Windows)
# Aufruf:  powershell -ExecutionPolicy Bypass -File .\\install-devdeck-agent.ps1
# Das Skript enthält das einmalige Enrollment-Token (läuft ab) – nach der Installation bitte löschen.
$ErrorActionPreference = 'Stop'
$Server = ${ps(o.server)}
$Token = ${ps(o.token)}
$Repo = ${ps(o.repo)}
$Branch = ${ps(o.branch)}

function Ask($prompt, $default) {
  $v = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}
function AskYesNo($prompt, [bool]$default) {
  $hint = if ($default) { 'J/n' } else { 'j/N' }
  $v = Read-Host "$prompt [$hint]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim().ToLower() -in @('j', 'ja', 'y', 'yes')
}
function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') ist fehlgeschlagen (Code $LASTEXITCODE)" }
}
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Node-Ok {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  $v = [version]((& node -p "process.versions.node") -replace '[^0-9.]', '')
  return ($v.Major -gt 22) -or ($v.Major -eq 22 -and $v.Minor -ge 5)
}

Write-Host ''
Write-Host 'DevDeck Agent – Installation' -ForegroundColor Cyan
Write-Host "Server: $Server"
Write-Host ''

# Voraussetzungen: Git und Node.js (ab 22.5)
$missing = @()
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $missing += @{ name = 'Git'; id = 'Git.Git' } }
if (-not (Node-Ok)) { $missing += @{ name = 'Node.js (ab 22.5)'; id = 'OpenJS.NodeJS.LTS' } }
if ($missing.Count -gt 0) {
  Write-Host ('Es fehlt: ' + (($missing | ForEach-Object { $_.name }) -join ', ')) -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if (AskYesNo 'Per winget installieren?' $true) {
      foreach ($m in $missing) { Run 'winget' @('install', '--id', $m.id, '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements') }
      Refresh-Path
    }
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Node-Ok)) {
    throw 'Git und Node.js (ab 22.5) müssen installiert sein. Danach das Skript in einer neuen PowerShell erneut starten.'
  }
}

# Rückfragen
$InstallPath = Ask 'Installationsordner' ${o.installPath ? ps(o.installPath) : `"${d.install}"`}
$Workspace = Ask 'Workspace-Root (hier legt DevDeck Projekte ab)' ${o.workspaceRoot ? ps(o.workspaceRoot) : `"${d.workspace}"`}
$Name = Ask 'Name dieser Maschine in DevDeck' ${o.name ? ps(o.name) : '$env:COMPUTERNAME'}
$Autostart = AskYesNo 'Agent beim Anmelden automatisch starten?' ${o.autostart ? '$true' : '$false'}

Write-Host ''
Write-Host "Installationsordner: $InstallPath"
Write-Host "Workspace-Root:      $Workspace"
Write-Host "Maschinenname:       $Name"
Write-Host ("Autostart:           " + $(if ($Autostart) { 'ja' } else { 'nein' }))
if (-not (AskYesNo 'Jetzt installieren?' $true)) { Write-Host 'Abgebrochen.'; return }

# Code holen und bauen
if (Test-Path (Join-Path $InstallPath '.git')) {
  Write-Host 'Vorhandene Installation gefunden – wird aktualisiert.'
  Run 'git' @('-C', $InstallPath, 'fetch', 'origin')
  Run 'git' @('-C', $InstallPath, 'checkout', $Branch)
  Run 'git' @('-C', $InstallPath, 'pull', '--ff-only')
} else {
  if ((Test-Path $InstallPath) -and (Get-ChildItem $InstallPath -Force | Select-Object -First 1)) { throw "Der Ordner $InstallPath ist nicht leer." }
  Run 'git' @('clone', '--branch', $Branch, $Repo, $InstallPath)
}
Push-Location $InstallPath
try {
  Run 'npm' @('ci', '--no-audit', '--no-fund')
  Run 'npm' @('run', 'build')
  $agent = Join-Path $InstallPath 'packages\\agent\\dist\\index.js'
  Run 'node' @($agent, 'enroll', '--server', $Server, '--token', $Token, '--name', $Name, '--workspace-root', $Workspace)
  if ($Autostart) { Run 'node' @($agent, 'autostart', 'on') } else { & node $agent autostart off | Out-Null }
  Run 'node' @($agent, 'start-background')
} finally { Pop-Location }

Write-Host ''
Write-Host 'Fertig. Die Maschine erscheint in DevDeck unter "Maschinen".' -ForegroundColor Green
Write-Host "Log: $env:USERPROFILE\\.devdeck\\agent.log"
Write-Host 'Hinweis: Damit DevDeck Windows-Updates installieren kann, muss der Agent mit Administratorrechten laufen.'
`;
}

function unixScript(os, o) {
  const d = defaultsFor(os);
  const hint = os === 'macos'
    ? 'Installation z. B. mit Homebrew:  brew install git node'
    : 'Installation z. B. per Paketmanager (apt/dnf) oder nvm (https://github.com/nvm-sh/nvm)';
  return `#!/usr/bin/env bash
# DevDeck Agent – Installation (${os === 'macos' ? 'macOS' : 'Linux'})
# Aufruf:  bash install-devdeck-agent.sh
# Das Skript enthält das einmalige Enrollment-Token (läuft ab) – nach der Installation bitte löschen.
set -euo pipefail
SERVER=${sh(o.server)}
TOKEN=${sh(o.token)}
REPO=${sh(o.repo)}
BRANCH=${sh(o.branch)}

ask() { local v=""; read -r -p "$1 [$2]: " v </dev/tty || true; printf '%s' "\${v:-$2}"; }
yesno() { local v="" hint="J/n"; [ "$2" = N ] && hint="j/N"; read -r -p "$1 [$hint]: " v </dev/tty || true; v="\${v:-$2}"; case "$v" in [JjYy]*) return 0;; *) return 1;; esac; }
expand() { case "$1" in "~") printf '%s' "$HOME";; "~/"*) printf '%s' "$HOME/\${1#\\~/}";; *) printf '%s' "$1";; esac; }

echo
echo "DevDeck Agent – Installation"
echo "Server: $SERVER"
echo

# Voraussetzungen: git und Node.js (ab 22.5)
command -v git >/dev/null 2>&1 || { echo "git fehlt. ${hint}" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js fehlt (ab 22.5). ${hint}" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' || { echo "Node.js $(node -v) ist zu alt – benötigt wird ab 22.5. ${hint}" >&2; exit 1; }

# Rückfragen
INSTALL_PATH="$(expand "$(ask 'Installationsordner' ${o.installPath ? sh(o.installPath) : `"${d.install}"`})")"
WORKSPACE="$(expand "$(ask 'Workspace-Root (hier legt DevDeck Projekte ab)' ${o.workspaceRoot ? sh(o.workspaceRoot) : `"${d.workspace}"`})")"
NAME="$(ask 'Name dieser Maschine in DevDeck' ${o.name ? sh(o.name) : '"$(hostname)"'})"
if yesno 'Agent beim ${os === 'macos' ? 'Anmelden' : 'Anmelden/Hochfahren'} automatisch starten?' '${o.autostart ? 'J' : 'N'}'; then AUTOSTART=1; else AUTOSTART=0; fi
echo
echo "Installationsordner: $INSTALL_PATH"
echo "Workspace-Root:      $WORKSPACE"
echo "Maschinenname:       $NAME"
echo "Autostart:           $([ "$AUTOSTART" = 1 ] && echo ja || echo nein)"
yesno 'Jetzt installieren?' 'J' || { echo 'Abgebrochen.'; exit 0; }

# Code holen und bauen
if [ -d "$INSTALL_PATH/.git" ]; then
  echo 'Vorhandene Installation gefunden – wird aktualisiert.'
  git -C "$INSTALL_PATH" fetch origin
  git -C "$INSTALL_PATH" checkout "$BRANCH"
  git -C "$INSTALL_PATH" pull --ff-only
else
  if [ -d "$INSTALL_PATH" ] && [ -n "$(ls -A "$INSTALL_PATH" 2>/dev/null)" ]; then echo "Der Ordner $INSTALL_PATH ist nicht leer." >&2; exit 1; fi
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_PATH"
fi
cd "$INSTALL_PATH"
npm ci --no-audit --no-fund
npm run build
AGENT="$INSTALL_PATH/${AGENT_JS}"
node "$AGENT" enroll --server "$SERVER" --token "$TOKEN" --name "$NAME" --workspace-root "$WORKSPACE"
if [ "$AUTOSTART" = 1 ]; then node "$AGENT" autostart on; else node "$AGENT" autostart off || true; fi
node "$AGENT" start-background

echo
echo 'Fertig. Die Maschine erscheint in DevDeck unter "Maschinen".'
echo "Log: $HOME/.devdeck/agent.log"
`;
}

/** Skript mit Rückfragen (Standardwerte aus dem Formular). Liefert Dateiname, Inhalt und Zeilenende passend zum System. */
export function installScript(os, raw) {
  const o = norm(raw);
  if (os === 'windows') return { filename: 'install-devdeck-agent.ps1', content: '\uFEFF' + windowsScript(o).replace(/\r?\n/g, '\r\n'), mime: 'text/plain' };
  return { filename: 'install-devdeck-agent.sh', content: unixScript(os, o), mime: 'text/x-shellscript' };
}

/** Vorbelegung der Betriebssystem-Auswahl nach dem Browser. */
export function guessOs(platformString = '') {
  const p = String(platformString).toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'linux';
}
