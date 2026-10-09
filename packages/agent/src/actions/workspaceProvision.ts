import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@devdeck/shared';
import { registerAction } from './index.js';
import { resolveWorkspacePath } from './workspaceStatus.js';
import { loadManifest } from '../manifest.js';
import { clone, gitStatus, isGitRepo, pullFFOnly } from '../git.js';
import { buildReadiness } from '../readiness.js';
import { installDependencies, lockfileHash } from '../dependencies.js';
import { checkTool, requiredTools } from '../tools.js';

const step = (name: string, detail?: string): Record<string, unknown> =>
  detail === undefined ? { step: name, status: 'ok' } : { step: name, status: 'ok', detail };

/**
 * workspace.provision – idempotente Workspace-Einrichtung (Spezifikation §9):
 * Clone → Toolchain → Dependencies → Secrets → .env → Secret Files → Context →
 * Workspace Readiness → READY. Jeder Schritt prüft den Vorzustand.
 */
registerAction('workspace.provision', async (ctx) => {
  const steps: Array<Record<string, unknown>> = [];
  const rawPath = ctx.payload.local_path;
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new AppError('VALIDATION', 'local_path ist erforderlich');
  }
  const workspacePath = path.resolve(rawPath);
  const root = path.resolve(ctx.config.workspaceRoot);
  const rel = path.relative(root, workspacePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError('FORBIDDEN', `Pfad liegt außerhalb des Workspace-Root (${root})`);
  }

  const repoRemote =
    typeof ctx.payload.repo_remote === 'string' && ctx.payload.repo_remote
      ? ctx.payload.repo_remote
      : null;
  const branch = typeof ctx.payload.branch === 'string' ? ctx.payload.branch : null;
  const workspaceId =
    typeof ctx.payload.workspace_id === 'string' ? ctx.payload.workspace_id : null;

  // --- 1) Clone (nur wenn Verzeichnis/Repo fehlt) ---
  if (!fs.existsSync(workspacePath)) {
    if (!repoRemote) {
      throw new AppError(
        'VALIDATION',
        'Verzeichnis fehlt – repo_remote wird für das Clonen benötigt',
      );
    }
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    await clone(repoRemote, workspacePath, branch);
    steps.push(step('clone', `von ${repoRemote}`));
  } else {
    steps.push(step('clone', 'bestehend – übersprungen'));
  }

  const isRepo = await isGitRepo(workspacePath);
  if (!isRepo) {
    const content = fs.readdirSync(workspacePath).filter((n) => n !== '.devdeck');
    if (content.length > 0) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'Verzeichnis enthält Inhalte, ist aber kein Git-Repository – Provisioning gestoppt',
        { local_path: workspacePath },
      );
    }
    if (!repoRemote) throw new AppError('VALIDATION', 'Kein Git-Repository und kein repo_remote');
    await clone(repoRemote, workspacePath, branch);
    steps.push(step('clone', 'in bestehendes leeres Verzeichnis'));
  }

  const before = await gitStatus(workspacePath);
  if (before.dirty) {
    throw new AppError(
      'GIT_DIRTY',
      'Lokale Änderungen vorhanden – Provisioning stoppt, damit nichts überschrieben wird',
      { files: before.files.slice(0, 50) },
    );
  }
  if (before.branch && before.behind > 0) {
    await pullFFOnly(workspacePath);
    steps.push(step('git_update', 'pull --ff-only'));
  }

  // --- 2) Toolchain-Check ---
  const manifest = loadManifest(workspacePath);
  const missing: string[] = [];
  for (const tool of requiredTools(manifest)) {
    if (tool.level !== 'required') continue;
    const check = await checkTool(tool.name, 'required');
    if (check.status !== 'OK') missing.push(tool.name);
  }
  if (missing.length > 0) {
    throw new AppError('TOOL_MISSING', `Fehlende Werkzeuge: ${missing.join(', ')}`, {
      tools: missing,
    });
  }
  steps.push(step('toolchain'));

  // --- 3) Dependencies (nur wenn Lockfile-Hash sich geändert hat) ---
  let depResult = 'skipped';
  if (manifest?.package_manager) {
    const hash = await lockfileHash(workspacePath);
    const statePath = path.join(workspacePath, '.devdeck', 'state.json');
    let previous: string | null = null;
    try {
      if (fs.existsSync(statePath)) {
        previous =
          (JSON.parse(fs.readFileSync(statePath, 'utf8')) as { lockfile_hash?: string })
            .lockfile_hash ?? null;
      }
    } catch {
      previous = null;
    }
    if (hash !== previous) {
      const result = await installDependencies(workspacePath, manifest);
      depResult = 'installed';
      steps.push({ step: 'dependencies', status: 'ok', command: result.command });
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ lockfile_hash: hash }), 'utf8');
    } else {
      depResult = 'up-to-date';
      steps.push({ step: 'dependencies', status: 'ok', detail: 'up-to-date' });
    }
  }

  // --- 4+5) Secrets & .env projektieren (Vault-Endpunkt, Phase G) ---
  const secretsRes = await ctx.client.request('POST', '/api/agent/secrets/fetch', {
    body: { workspace_id: workspaceId, local_path: workspacePath, include: ['env', 'files'] },
  });
  let secretsStep = 'skipped';
  if (secretsRes.status === 200 && secretsRes.data) {
    const data = secretsRes.data as {
      env?: Record<string, string>;
      files?: Array<{ target_path: string; content_base64: string }>;
    };
    const envTarget = path.basename(manifest?.environment?.target ?? '.env');
    if (data.env && Object.keys(data.env).length > 0) {
      const envPath = path.join(workspacePath, envTarget);
      const lines = Object.entries(data.env).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
      fs.chmodSync(envPath, 0o600);
      steps.push(step('env', envTarget));
      secretsStep = 'env-written';
    }
    for (const file of data.files ?? []) {
      const target = path.resolve(workspacePath, path.basename(file.target_path));
      if (!target.startsWith(path.resolve(workspacePath) + path.sep)) {
        throw new AppError('FORBIDDEN', 'Secret-Datei-Zielpfad außerhalb des Workspaces');
      }
      fs.writeFileSync(target, Buffer.from(file.content_base64, 'base64'), { mode: 0o600 });
      fs.chmodSync(target, 0o600);
      steps.push(step('secret_file', path.basename(file.target_path)));
      secretsStep = 'files-written';
    }
  } else {
    steps.push(step('secrets', 'Vault-Endpunkt nicht verfügbar – übersprungen'));
  }

  // --- 6) Context erzeugen (Phase F) ---
  const ctxRes = await ctx.client.request('POST', '/api/agent/context/write', {
    body: { workspace_id: workspaceId, local_path: workspacePath },
  });
  steps.push(
    ctxRes.status === 200
      ? step('context')
      : step('context', 'Context-Endpunkt nicht verfügbar – übersprungen'),
  );

  // --- 7) Workspace Readiness ---
  const finalState = await gitStatus(workspacePath);
  const readiness = await buildReadiness({
    workspacePath,
    manifest,
    gitState: finalState,
    isRepo: true,
    gitAvailable: true,
  });
  if (workspaceId) {
    await ctx.client.request('POST', `/api/agent/workspaces/${workspaceId}/status`, {
      body: { git: finalState, readiness },
    });
  }

  return {
    local_path: workspacePath,
    steps,
    dependencies: depResult,
    secrets: secretsStep,
    readiness: readiness as unknown as Record<string, unknown>,
    overall: readiness.overall,
  };
});
