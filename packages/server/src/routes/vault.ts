import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  AppError,
  type SecretDto,
  type SecretGrantDto,
  type SecretTargetDto,
  type SecretCapability,
  type SecretKind,
  type Environment,
} from '@devdeck/shared';
import {
  asyncHandler,
  optionalString,
  param,
  requireString,
  clientIp,
} from '../http.js';
import type { AppContext } from '../context.js';
import { requireUser, requireProjectRole, secretCapabilitiesFor } from '../auth/middleware.js';
import { audit } from '../services/audit.js';
import { VaultService } from '../vault/vault.js';

export function vaultRoutes(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireUser(db));

  function requireVault(): VaultService {
    if (!ctx.vault) throw new AppError('VAULT_ERROR', 'Vault ist auf diesem Server nicht initialisiert');
    return ctx.vault;
  }

  function toSecretDto(row: any): SecretDto {
    return {
      id: row.id,
      project_id: row.project_id,
      name: row.name,
      description: row.description ?? null,
      kind: row.kind as SecretKind,
      environment: row.environment as Environment,
      vault_reference: row.vault_reference,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by ?? null,
      created_by_email: row.created_by_email ?? null,
      has_value: ctx.vault ? ctx.vault.has(row.vault_reference) : Boolean(row.has_value),
    };
  }

  function toSecretGrantDto(row: any): SecretGrantDto {
    return {
      id: row.id,
      secret_id: row.secret_id,
      subject_type: row.subject_type as 'member' | 'user' | 'machine' | 'role',
      subject_id: row.subject_id,
      capability: row.capability as SecretCapability,
      created_at: row.created_at,
      created_by: row.created_by ?? null,
      created_by_email: row.created_by_email ?? null,
    };
  }

  function toSecretTargetDto(row: any): SecretTargetDto {
    return {
      id: row.id,
      secret_id: row.secret_id,
      target_path: row.target_path,
      file_mode: row.file_mode,
    };
  }

  // Liste alle Secrets für ein Projekt (Metadaten, KEINE Werte)
  router.get(
    '/projects/:projectId/secrets',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const projectId = req.project!.id;
      const kind = optionalString(req.query, 'kind');
      const environment = optionalString(req.query, 'environment');
      const limit = Number(req.query?.limit ?? 50);
      const offset = Number(req.query?.offset ?? 0);

      let query = `
        SELECT s.*, u.email AS created_by_email
        FROM secrets s
        LEFT JOIN users u ON u.id = s.created_by
        WHERE s.project_id = ?`;
      const params: any[] = [projectId];

      if (kind) {
        query += ' AND s.kind = ?';
        params.push(kind);
      }
      if (environment) {
        query += ' AND s.environment = ?';
        params.push(environment);
      }

      query += ` ORDER BY s.environment, s.name
        LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const secrets = db.all<any>(query, ...params);
      res.json({ data: secrets.map(toSecretDto) });
    })
  );

  // Erstelle ein neues Secret (nur Metadaten; Wert über /values POST)
  router.post(
    '/projects/:projectId/secrets',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const projectId = req.project!.id;
      const userId = req.user!.id;

      const name = requireString(req.body, 'name').trim();
      const description = optionalString(req.body, 'description', 1000);
      const kind = optionalString(req.body, 'kind') as SecretKind | undefined;
      const environment = optionalString(req.body, 'environment') as Environment | undefined;

      if (!kind) throw new AppError('VALIDATION', 'kind ist erforderlich');
      if (!['env', 'file', 'json'].includes(kind)) {
        throw new AppError('VALIDATION', 'Ungültiger Secret-Typ');
      }
      if (!environment) throw new AppError('VALIDATION', 'environment ist erforderlich');

      const existing = db.get<{ id: string }>(
        'SELECT id FROM secrets WHERE project_id = ? AND name = ? AND environment = ?',
        projectId,
        name,
        environment
      );
      if (existing) {
        throw new AppError('CONFLICT', `Secret "${name}" existiert bereits`);
      }

      const secretId = randomUUID();
      const vaultReference = randomUUID();
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO secrets (id, project_id, name, description, kind, environment,
         vault_reference, version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        secretId, projectId, name, description, kind, environment, vaultReference, now, now, userId
      );

      // subject_type 'user' (nicht 'member' – das wird von secretCapabilitiesFor nicht ausgewertet)
      db.run(
        `INSERT INTO secret_grants (id, secret_id, subject_type, subject_id, capability, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), secretId, 'user', userId, 'secret.update', now, userId
      );

      audit(db, {
        actor_type: 'user', actor_id: userId, actor_label: req.user!.email,
        action: 'secret.create', project_id: projectId,
        target_type: 'secret', target_id: secretId, result: 'success',
        detail: { name, kind, environment, vault_reference: vaultReference },
        ip: clientIp(req),
      });

      const secret = db.get<any>(
        'SELECT s.*, u.email AS created_by_email FROM secrets s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?',
        secretId
      );
      res.status(201).json({ data: toSecretDto(secret) });
    })
  );

  // Hole Details eines Secrets
  router.get(
    '/projects/:projectId/secrets/:secretId',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      const secret = db.get<any>(
        'SELECT s.*, u.email AS created_by_email FROM secrets s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?',
        secretId
      );
      if (!secret) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      res.json({ data: toSecretDto(secret) });
    })
  );

  // Aktualisiere Metadaten eines Secrets
  router.patch(
    '/projects/:projectId/secrets/:secretId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');

      const description = optionalString(req.body, 'description', 1000);
      const updatedAt = new Date().toISOString();
      const updates: string[] = [];
      const params: any[] = [];
      if (description !== undefined) { updates.push('description = ?'); params.push(description); }
      if (updates.length === 0) throw new AppError('VALIDATION', 'Keine Änderungen');
      updates.push('updated_at = ?'); params.push(updatedAt); params.push(secretId);
      db.run(`UPDATE secrets SET ${updates.join(', ')} WHERE id = ?`, ...params);

      const secret = db.get<any>(
        'SELECT s.*, u.email AS created_by_email FROM secrets s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?',
        secretId
      );
      audit(db, { actor_type: 'user', actor_id: req.user!.id as string | null, actor_label: req.user!.email as string | null, action: 'secret.update', project_id: req.project!.id as string | null, target_type: 'secret' as string | null, target_id: secretId as string | null, result: 'success', detail: { description: description as string | null } as Record<string, unknown>, ip: clientIp(req) as string | null });
      res.json({ data: toSecretDto(secret) });
    })
  );

  // Lösche ein Secret
  router.delete(
    '/projects/:projectId/secrets/:secretId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      const secret = db.get<any>('SELECT name, vault_reference FROM secrets WHERE id = ?', secretId);
      if (!secret) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      try {
        ctx.vault?.delete(secret.vault_reference);
      } catch {
        /* Platzhalter-Referenz ohne gespeicherten Wert – nichts zu löschen */
      }
      db.run('DELETE FROM secret_grants WHERE secret_id = ?', secretId);
      db.run('DELETE FROM secret_targets WHERE secret_id = ?', secretId);
      db.run('DELETE FROM secrets WHERE id = ?', secretId);
            audit(db, { actor_type: 'user', actor_id: req.user!.id as string | null, actor_label: req.user!.email as string | null, action: 'secret.delete', project_id: req.project!.id as string | null, target_type: 'secret' as string | null, target_id: secretId as string | null, result: 'success', detail: { name: secret.name as string | null } as Record<string, unknown>, ip: clientIp(req) as string | null });
      res.json({ data: { id: secretId, deleted: true } });
    })
  );

  // --- Grant Management ---

  // Erstelle einen Grant
  router.post(
    '/projects/:projectId/secrets/:secretId/grants',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');

      const subjectType = optionalString(req.body, 'subject_type') as 'member' | 'user' | 'machine' | 'role';
      const subjectId = requireString(req.body, 'subject_id');
      const capability = optionalString(req.body, 'capability') as SecretCapability;
      if (!subjectType) throw new AppError('VALIDATION', 'subject_type ist erforderlich');
      if (!['member', 'user', 'machine', 'role'].includes(subjectType)) {
        throw new AppError('VALIDATION', 'Ungültiger subject_type');
      }
      if (!capability || !['secret.metadata.read', 'secret.use', 'secret.reveal', 'secret.update', 'secret.file.deploy'].includes(capability)) {
        throw new AppError('VALIDATION', 'Ungültige capability');
      }

      const grantId = randomUUID();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO secret_grants (id, secret_id, subject_type, subject_id, capability, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        grantId, secretId, subjectType, subjectId, capability, now, req.user!.id
      );
      audit(db, { actor_type: 'user', actor_id: req.user!.id as string | null, actor_label: req.user!.email as string | null, action: 'secret.grant.create', project_id: req.project!.id as string | null, target_type: 'secret' as string | null, target_id: secretId as string | null, result: 'success', detail: { subject_type: subjectType as string | null, subject_id: subjectId as string, capability: capability as string | null } as Record<string, unknown>, ip: clientIp(req) as string | null });

      const grantRow = db.get<any>(
        'SELECT sg.*, u.email AS created_by_email FROM secret_grants sg LEFT JOIN users u ON u.id = sg.created_by WHERE sg.id = ?',
        grantId
      );
      res.status(201).json({ data: toSecretGrantDto(grantRow) });
    })
  );

  // Liste Grants für ein Secret
  router.get(
    '/projects/:projectId/secrets/:secretId/grants',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      const grants = db.all<any>(
        'SELECT sg.*, u.email AS created_by_email FROM secret_grants sg LEFT JOIN users u ON u.id = sg.created_by WHERE sg.secret_id = ? ORDER BY sg.created_at DESC',
        secretId
      );
      res.json({ data: grants.map(toSecretGrantDto) });
    })
  );

  // Entferne einen Grant
  router.delete(
    '/projects/:projectId/secrets/:secretId/grants/:grantId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grantId = req.params.grantId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      db.run('DELETE FROM secret_grants WHERE id = ?', grantId);
            audit(db, { actor_type: 'user', actor_id: req.user!.id as string | null, actor_label: req.user!.email as string | null, action: 'secret.grant.delete', project_id: req.project!.id as string | null, target_type: 'secret' as string | null, target_id: secretId as string | null, result: 'success', detail: { grant_id: grantId as string | null } as Record<string, unknown>, ip: clientIp(req) as string | null });
      res.json({ data: { id: grantId, deleted: true } });
    })
  );

  // --- Value Management ---

  router.post(
    '/projects/:projectId/secrets/:secretId/values',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = param(req, 'secretId')!;
      const userId = req.user!.id;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      if (grant.capability === 'secret.metadata.read') {
        throw new AppError('FORBIDDEN', 'Schreibzugriff benötigt');
      }
      const value = requireString(req.body, 'value');
      const secret = db.get<any>(
        'SELECT name, environment, version, vault_reference FROM secrets WHERE id = ?',
        secretId,
      );
      if (!secret) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');

      const version = secret.version + 1;
      const aad = VaultService.aad(req.project!.id, secret.name, secret.environment, version);
      // Dieselbe secretId als Vault-Row-Id wiederverwenden → ein Eintrag pro Secret, versioniert.
      const vaultReference = requireVault().put(value, aad, secretId);
      const updatedAt = new Date().toISOString();
      db.run(
        'UPDATE secrets SET vault_reference = ?, version = ?, updated_at = ? WHERE id = ?',
        vaultReference,
        version,
        updatedAt,
        secretId,
      );
      audit(db, {
        actor_type: 'user', actor_id: userId, actor_label: req.user!.email,
        action: 'secret.value.set', project_id: req.project!.id,
        target_type: 'secret', target_id: secretId, result: 'success',
        detail: { version }, ip: clientIp(req),
      });
      res.json({ data: { version, vault_reference: vaultReference } });
    })
  );

  // Hole den entschlüsselten Wert (nur mit secret.reveal-Capability; wird auditiert)
  router.get(
    '/projects/:projectId/secrets/:secretId/values',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const secretId = param(req, 'secretId')!;
      const secret = db.get<any>(
        'SELECT name, environment, vault_reference FROM secrets WHERE id = ?',
        secretId,
      );
      if (!secret) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');

      const role = req.projectRole!;
      const caps = secretCapabilitiesFor(db, secretId, req.user!.id, role);
      if (!caps.has('secret.reveal')) {
        audit(db, {
          actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email,
          action: 'secret.reveal', project_id: req.project!.id,
          target_type: 'secret', target_id: secretId, result: 'denied',
          ip: clientIp(req),
        });
        throw new AppError('FORBIDDEN', 'Capability secret.reveal nicht vergeben');
      }

      const vault = requireVault();
      if (!vault.has(secret.vault_reference)) {
        res.json({ data: { has_value: false } });
        return;
      }
      const value = vault.getString(secret.vault_reference);
      audit(db, {
        actor_type: 'user', actor_id: req.user!.id, actor_label: req.user!.email,
        action: 'secret.reveal', project_id: req.project!.id,
        target_type: 'secret', target_id: secretId, result: 'success',
        ip: clientIp(req),
      });
      res.json({ data: { has_value: true, value } });
    })
  );

  // --- Projection (Target-Mapping) ---

  router.post(
    '/projects/:projectId/secrets/:secretId/targets',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      if (grant.capability === 'secret.metadata.read') {
        throw new AppError('FORBIDDEN', 'Keine Schreibberechtigung');
      }
      const targetPath = requireString(req.body, 'target_path');
      const fileMode = optionalString(req.body, 'file_mode') ?? '0600';
      const targetId = randomUUID();
      db.run('INSERT INTO secret_targets (id, secret_id, target_path, file_mode) VALUES (?, ?, ?, ?)', targetId, secretId, targetPath, fileMode);
            audit(db, { actor_type: 'user', actor_id: req.user!.id as string | null, actor_label: req.user!.email as string | null, action: 'secret.target.create', project_id: req.project!.id as string | null, target_type: 'secret' as string | null, target_id: secretId as string | null, result: 'success', detail: { target_path: targetPath as string | null, file_mode: fileMode as string | null } as Record<string, unknown>, ip: clientIp(req) as string | null });
      res.status(201).json({ data: { id: targetId, secret_id: secretId, target_path: targetPath, file_mode: fileMode } });
    })
  );

  router.get(
    '/projects/:projectId/secrets/:secretId/targets',
    requireProjectRole(db, 'viewer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      const targets = db.all<any>('SELECT * FROM secret_targets WHERE secret_id = ?', secretId);
      res.json({ data: targets.map(toSecretTargetDto) });
    })
  );

  router.delete(
    '/projects/:projectId/secrets/:secretId/targets/:targetId',
    requireProjectRole(db, 'maintainer'),
    asyncHandler(async (req, res) => {
      const secretId = req.params.secretId;
      const targetId = req.params.targetId;
      const grant = db.get<any>('SELECT capability FROM secret_grants WHERE secret_id = ?', secretId);
      if (!grant) throw new AppError('NOT_FOUND', 'Secret nicht gefunden');
      if (grant.capability === 'secret.metadata.read') {
        throw new AppError('FORBIDDEN', 'Keine Schreibberechtigung');
      }
      db.run('DELETE FROM secret_targets WHERE id = ?', targetId);
            audit(db, { actor_type: 'user', actor_id: req.user!.id as string | null, actor_label: req.user!.email as string | null, action: 'secret.target.delete', project_id: req.project!.id as string | null, target_type: 'secret' as string | null, target_id: secretId as string | null, result: 'success', detail: { target_id: targetId as string | null } as Record<string, unknown>, ip: clientIp(req) as string | null });
      res.json({ data: { id: targetId, deleted: true } });
    })
  );

  return router;
}
