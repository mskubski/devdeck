import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, MAX_PATCH_INSTALL_IDS, PATCH_ID_PATTERN, type MachinePatchInstallResult, type MachinePatches } from '@devdeck/shared';
import { collectPatches } from './patches.js';

const exec = promisify(execFile);

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InstallDeps {
  platform: NodeJS.Platform;
  isRoot: boolean;
  scan: () => Promise<MachinePatches>;
  /** Festes Programm mit festen Argumenten (keine Shell). */
  run: (file: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<RunResult>;
}

async function runReal(file: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      timeout: opts.timeoutMs ?? 20 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message ?? '') };
  }
}

export function realDeps(): InstallDeps {
  return { platform: process.platform, isRoot: typeof process.getuid === 'function' && process.getuid() === 0, scan: collectPatches, run: runReal };
}

export function validateIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError('VALIDATION', 'ids muss eine nicht leere Liste sein');
  const ids = [...new Set(raw)];
  if (ids.length > MAX_PATCH_INSTALL_IDS) throw new AppError('VALIDATION', `Höchstens ${MAX_PATCH_INSTALL_IDS} Updates auf einmal`);
  for (const id of ids) {
    if (typeof id !== 'string' || !PATCH_ID_PATTERN.test(id)) throw new AppError('VALIDATION', 'Ungültige Update-Kennung');
  }
  return ids as string[];
}

const lastLine = (r: RunResult): string => {
  const text = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (text[text.length - 1] ?? `Beendet mit Code ${r.code}`).slice(0, 250);
};

// ───────────────────────────── Windows ─────────────────────────────

/** Installiert genau die übergebenen Update-IDs über den Windows Update Agent (erfordert Administratorrechte); ein Neustart wird nie ausgelöst. */
export function windowsInstallScript(ids: string[]): string {
  if (!ids.every((i) => GUID.test(i))) throw new AppError('VALIDATION', 'Ungültige Windows-Update-ID');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ids = @(${ids.map((i) => `'${i}'`).join(', ')})
$res = @{ admin = $false; items = @(); reboot = $false; error = $null }
$res.admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($res.admin) {
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
    $coll = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $found.Updates) {
      if ($ids -contains [string]$u.Identity.UpdateID) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$coll.Add($u) }
    }
    if ($coll.Count -gt 0) {
      $d = $session.CreateUpdateDownloader(); $d.Updates = $coll; [void]$d.Download()
      $inst = $session.CreateUpdateInstaller(); $inst.Updates = $coll
      $inst.AllowSourcePrompts = $false
      $ir = $inst.Install()
      for ($i = 0; $i -lt $coll.Count; $i++) {
        $r = $ir.GetUpdateResult($i)
        $res.items += @{ id = [string]$coll.Item($i).Identity.UpdateID; code = [int]$r.ResultCode; hresult = [int]$r.HResult }
      }
      $res.reboot = [bool]$ir.RebootRequired
    }
  } catch { $res.error = $_.Exception.Message }
}
ConvertTo-Json -InputObject $res -Compress -Depth 4
`;
}

interface WinInstallOut {
  admin?: boolean;
  items?: Array<{ id?: string; code?: number; hresult?: number }> | { id?: string; code?: number; hresult?: number };
  reboot?: boolean;
  error?: string | null;
}

/** Auswertung der PowerShell-Ausgabe: Fehlertexte je Update-ID, Neustart-Hinweis. */
export function parseWindowsInstall(text: string, ids: string[]): { failures: Map<string, string>; reboot: boolean } {
  const failures = new Map<string, string>();
  let out: WinInstallOut;
  try {
    out = JSON.parse(text) as WinInstallOut;
  } catch {
    for (const id of ids) failures.set(id, 'Keine auswertbare Antwort von Windows Update');
    return { failures, reboot: false };
  }
  if (out.admin === false) {
    for (const id of ids) failures.set(id, 'Der Agent läuft ohne Administratorrechte – Windows-Updates lassen sich nur mit einem Agent installieren, der „als Administrator“ (oder als Dienst) läuft.');
    return { failures, reboot: false };
  }
  if (out.error) {
    const hint = /0x80070005|Zugriff|access is denied/i.test(out.error) ? ' (Zugriff verweigert – läuft der Agent in einer lokalen, angemeldeten Sitzung mit Administratorrechten?)' : '';
    for (const id of ids) failures.set(id, `Windows Update: ${out.error.slice(0, 200)}${hint}`);
  }
  const items = out.items == null ? [] : Array.isArray(out.items) ? out.items : [out.items];
  const seen = new Set<string>();
  for (const i of items) {
    if (!i.id) continue;
    seen.add(i.id.toLowerCase());
    // 2 = installiert, 3 = installiert mit Fehlern
    if (i.code !== 2 && i.code !== 3) failures.set(ids.find((x) => x.toLowerCase() === i.id!.toLowerCase()) ?? i.id, `Windows Update meldet Ergebnis ${i.code ?? '?'} (HRESULT 0x${((i.hresult ?? 0) >>> 0).toString(16)})`);
  }
  if (!out.error) for (const id of ids) if (!seen.has(id.toLowerCase())) failures.set(id, 'Update wurde von Windows Update nicht mehr angeboten');
  return { failures, reboot: Boolean(out.reboot) };
}

// ───────────────────────────── Ablauf ─────────────────────────────

type Step = { ids: string[]; file: string; args: string[]; env?: Record<string, string>; timeoutMs?: number; needsRoot: boolean };

function elevate(step: Step, deps: InstallDeps): { file: string; args: string[] } {
  return step.needsRoot && !deps.isRoot ? { file: 'sudo', args: ['-n', step.file, ...step.args] } : { file: step.file, args: step.args };
}

/** Schritte für Linux/macOS: ein Aufruf je Paketmanager bzw. je Update. */
export function planUnixSteps(platform: NodeJS.Platform, scanner: string, byKind: { os: string[]; app: string[] }): { steps: Step[]; unsupported: string | null } {
  const steps: Step[] = [];
  let unsupported: string | null = null;
  if (platform === 'darwin') {
    for (const id of byKind.os) steps.push({ ids: [id], file: 'softwareupdate', args: ['-i', id], needsRoot: true, timeoutMs: 40 * 60_000 });
    for (const id of byKind.app) steps.push({ ids: [id], file: 'brew', args: ['upgrade', id], needsRoot: false });
    return { steps, unsupported };
  }
  if (byKind.os.length) {
    if (scanner === 'apt') {
      steps.push({ ids: byKind.os, file: 'apt-get', args: ['install', '--only-upgrade', '-y', '-o', 'Dpkg::Options::=--force-confold', ...byKind.os], env: { DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' }, needsRoot: true });
    } else if (scanner === 'dnf') {
      steps.push({ ids: byKind.os, file: 'dnf', args: ['-y', 'upgrade', ...byKind.os], env: { LC_ALL: 'C' }, needsRoot: true });
    } else {
      unsupported = 'Die Installation einzelner Updates wird für diesen Paketmanager nicht unterstützt (apt und dnf; unter Arch sind Teil-Updates nicht empfohlen).';
    }
  }
  return { steps, unsupported };
}

/**
 * Wählt die Updates aus und installiert sie. Gelistet/zulässig ist nur, was eine frische Prüfung als ausstehend meldet;
 * ein Neustart wird NIE ausgelöst, sondern nur gemeldet. Das Ergebnis je Update ergibt sich aus der Prüfung nach der Installation.
 */
export async function installPatches(rawIds: unknown, deps: InstallDeps = realDeps()): Promise<{ results: MachinePatchInstallResult[]; reboot_required: boolean | null; patches: MachinePatches }> {
  const ids = validateIds(rawIds);
  const before = await deps.scan();
  const known = new Map((before.items ?? []).filter((i) => i.id).map((i) => [i.id!, i]));
  const results = new Map<string, MachinePatchInstallResult>();
  const wanted: string[] = [];
  for (const id of ids) {
    if (known.has(id)) wanted.push(id);
    else results.set(id, { id, name: null, ok: false, message: 'Wird nicht (mehr) als ausstehend gemeldet' });
  }
  const failures = new Map<string, string>();
  let reboot = false;
  const kindOf = (id: string): 'os' | 'app' => known.get(id)!.kind;
  const byKind = { os: wanted.filter((i) => kindOf(i) === 'os'), app: wanted.filter((i) => kindOf(i) === 'app') };

  if (wanted.length) {
    if (deps.platform === 'win32') {
      if (byKind.os.length) {
        const encoded = Buffer.from(windowsInstallScript(byKind.os), 'utf16le').toString('base64');
        const r = await deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs: 40 * 60_000 });
        const parsed = parseWindowsInstall(r.stdout.trim(), byKind.os);
        for (const [id, msg] of parsed.failures) failures.set(id, msg);
        reboot = reboot || parsed.reboot;
      }
      for (const id of byKind.app) {
        const r = await deps.run('winget', ['upgrade', '--id', id, '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'], { timeoutMs: 20 * 60_000 });
        if (r.code !== 0) failures.set(id, `winget: ${lastLine(r)}`);
      }
    } else {
      const plan = planUnixSteps(deps.platform, before.scanner, byKind);
      if (plan.unsupported) for (const id of byKind.os) failures.set(id, plan.unsupported);
      const needsSudo = plan.steps.some((s) => s.needsRoot) && !deps.isRoot;
      let sudoOk = true;
      if (needsSudo) {
        sudoOk = (await deps.run('sudo', ['-n', 'true'], { timeoutMs: 15_000 })).code === 0;
      }
      for (const step of plan.steps) {
        if (step.needsRoot && !sudoOk) {
          for (const id of step.ids) failures.set(id, 'Dafür sind Root-Rechte nötig: sudo verlangt ein Passwort. Den Agent als root betreiben oder eine sudoers-Regel (NOPASSWD) für den Paketmanager einrichten.');
          continue;
        }
        const cmd = elevate(step, deps);
        const r = await deps.run(cmd.file, cmd.args, { env: step.env, timeoutMs: step.timeoutMs });
        if (r.code !== 0) for (const id of step.ids) failures.set(id, `${step.file}: ${lastLine(r)}`);
      }
    }
  }

  const after = wanted.length ? await deps.scan() : before;
  const pending = new Set((after.items ?? []).map((i) => i.id).filter((i): i is string => Boolean(i)));
  for (const id of wanted) {
    const item = known.get(id)!;
    const still = pending.has(id);
    if (!still && /Neustart nötig/i.test(item.detail ?? '')) reboot = true;
    results.set(id, {
      id, name: item.name, ok: !still,
      message: still ? failures.get(id) ?? 'Nach der Installation weiterhin ausstehend (ggf. ist ein Neustart nötig)' : 'Installiert',
    });
  }
  const rebootRequired = after.reboot_required === true || reboot ? true : after.reboot_required;
  return { results: ids.map((id) => results.get(id)!), reboot_required: rebootRequired, patches: { ...after, reboot_required: rebootRequired } };
}
