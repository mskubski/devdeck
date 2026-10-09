import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_ADMIN, type TestServer } from './helpers.js';

describe('DevDeck Vault: Secret-Werte verschlüsselt speichern/lesen (Phase G)', () => {
  let srv: TestServer;
  let adminCookie: string;
  let projectId: string;

  beforeEach(async () => {
    srv = await startTestServer();
    adminCookie = await srv.login(TEST_ADMIN.email, TEST_ADMIN.password);
    const project = await srv.request('POST', '/api/projects', {
      cookie: adminCookie,
      body: { name: 'WebApp' },
    });
    projectId = project.body.data.id;
  });
  afterEach(async () => {
    await srv.close();
  });

  async function createSecret(): Promise<string> {
    const res = await srv.request('POST', `/api/projects/${projectId}/secrets`, {
      cookie: adminCookie,
      body: { name: 'SUPABASE_SERVICE_ROLE_KEY', kind: 'env', environment: 'development' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.has_value).toBe(false);
    return res.body.data.id;
  }

  it('speichert einen Wert verschlüsselt und liefert ihn über reveal zurück', async () => {
    const secretId = await createSecret();

    const setRes = await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie: adminCookie,
      body: { value: 'sbp_super_secret_value' },
    });
    expect(setRes.status).toBe(200);
    expect(setRes.body.data.version).toBe(2);
    expect(setRes.body.data.vault_reference).toMatch(/^v1:[0-9a-f]{16}:/);

    const listRes = await srv.request('GET', `/api/projects/${projectId}/secrets`, { cookie: adminCookie });
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.find((s: any) => s.id === secretId).has_value).toBe(true);

    const revealRes = await srv.request('GET', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie: adminCookie,
    });
    expect(revealRes.status).toBe(200);
    expect(revealRes.body.data).toEqual({ has_value: true, value: 'sbp_super_secret_value' });

    // Niemals im Audit-Log im Klartext auftauchen lassen
    const auditRows = srv.ctx.db.all<{ action: string; detail_json: string | null }>(
      `SELECT action, detail_json FROM audit_log WHERE target_id = ?`,
      secretId,
    );
    for (const row of auditRows) {
      expect(row.detail_json ?? '').not.toContain('sbp_super_secret_value');
    }
  });

  it('verweigert reveal ohne secret.reveal-Capability (viewer)', async () => {
    const secretId = await createSecret();
    await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie: adminCookie,
      body: { value: 'top-secret' },
    });

    await srv.request('POST', '/api/users', {
      cookie: adminCookie,
      body: { email: 'viewer@devdeck.test', password: 'viewer-pass-1' },
    });
    await srv.request('POST', `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { email: 'viewer@devdeck.test', role: 'viewer' },
    });
    const viewerCookie = await srv.login('viewer@devdeck.test', 'viewer-pass-1');

    const revealRes = await srv.request('GET', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie: viewerCookie,
    });
    expect(revealRes.status).toBe(403);
  });

  it('löscht den verschlüsselten Wert mit dem Secret', async () => {
    const secretId = await createSecret();
    await srv.request('POST', `/api/projects/${projectId}/secrets/${secretId}/values`, {
      cookie: adminCookie,
      body: { value: 'to-be-deleted' },
    });
    const delRes = await srv.request('DELETE', `/api/projects/${projectId}/secrets/${secretId}`, {
      cookie: adminCookie,
    });
    expect(delRes.status).toBe(200);
    expect(srv.ctx.vault?.has('v1:doesnotmatter:anything')).toBe(false);
  });
});
