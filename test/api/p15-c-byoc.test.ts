import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as listRoute from '../../src/app/api/studio/provider-credentials/route';
import * as keyRoute from '../../src/app/api/studio/provider-credentials/[providerId]/route';
import * as testRoute from '../../src/app/api/studio/provider-credentials/[providerId]/test/route';
import * as projectByocRoute from '../../src/app/api/studio/projects/[id]/byoc/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, tenant } from '../helpers/api-harness';

// Phase 15 track C, operator decision P1 (BYOC): provider keys per Enterprise organisation.
// Auth, validation, tenant isolation, audit (no key material), 403 outside Enterprise BYOC.

const hasDb = Boolean(process.env.DATABASE_URL);

function enterprise(organisationId: string, capabilities?: string[]): TenantContext {
  const base = tenant(organisationId, capabilities);
  return { ...base, organisation: { id: organisationId, planTier: 'ENTERPRISE' } };
}

describe.skipIf(!hasDb)('BYOC provider credentials API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-byoc-${randomUUID()}`;
  const otherOrg = `api-byoc-other-${randomUUID()}`;
  const tokens = {
    owner: enterprise(org),
    other: enterprise(otherOrg),
    readonly: enterprise(org, ['studio:project:read']),
    plus: tenant(`api-byoc-plus-${randomUUID()}`),
  };
  let api: ReturnType<typeof installApi>;

  // One install for the file: the harness key provider is per install, and stored keys must
  // stay decryptable across tests.
  beforeAll(() => {
    api = installApi(db, tokens);
  });

  beforeEach(() => {
    vi.stubEnv('STUDIO_BYOC_ENABLED', 'true');
    vi.stubEnv('STUDIO_USD_TO_GBP_RATE', '0.75');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.providerCredential.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const put = (token: string, providerId: string, body: unknown) =>
    call(keyRoute.PUT, { method: 'PUT', token, params: { providerId }, body });

  it('requires authentication and the connections capability', async () => {
    expect((await call(listRoute.GET, {})).status).toBe(401);
    expect((await call(listRoute.GET, { token: 'readonly' })).status).toBe(403);
    expect((await put('readonly', 'runway', { apiKey: 'rw-secret-abcd' })).status).toBe(403);
  });

  it('answers enabled:false when disabled and refuses mutations with feature_disabled', async () => {
    vi.stubEnv('STUDIO_BYOC_ENABLED', '');
    const list = await call(listRoute.GET, { token: 'owner' });
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ enabled: false, reason: 'disabled', credentials: [] });
    const res = await put('owner', 'runway', { apiKey: 'rw-secret-abcd' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('feature_disabled');
  });

  it('is Enterprise only (403 plan_tier)', async () => {
    const list = await call(listRoute.GET, { token: 'plus' });
    expect(list.json).toMatchObject({ enabled: false, reason: 'plan_tier' });
    const res = await put('plus', 'runway', { apiKey: 'rw-secret-abcd' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('plan_tier');
  });

  it('validates the provider and the key', async () => {
    expect((await put('owner', 'suno', { apiKey: 'rw-secret-abcd' })).status).toBe(404);
    expect((await put('owner', 'runway', { apiKey: 'short' })).status).toBe(400);
    expect((await put('owner', 'runway', {})).status).toBe(400);
    expect((await put('owner', 'storyblocks', { apiKey: 'public-1234' })).status).toBe(400);
  });

  it('stores a key, lists it by hint only and audits without key material', async () => {
    const res = await put('owner', 'runway', { apiKey: '  rw-secret-abcd  ' });
    expect(res.status).toBe(200);
    expect(res.json.credential).toMatchObject({
      providerId: 'runway',
      hint: 'abcd',
      state: 'active',
    });
    const list = await call(listRoute.GET, { token: 'owner' });
    expect(list.json).toMatchObject({ enabled: true });
    expect(list.json.credentials).toEqual([
      expect.objectContaining({ providerId: 'runway', hint: 'abcd' }),
    ]);
    expect(JSON.stringify(list.json)).not.toContain('rw-secret');
    const audit = api.audits.find((a) => a.action === 'studio.byoc.key_set');
    expect(audit).toBeDefined();
    expect(JSON.stringify(api.audits)).not.toContain('rw-secret');
  });

  it('keeps organisations isolated', async () => {
    const other = await call(listRoute.GET, { token: 'other' });
    expect(other.json.credentials).toEqual([]);
    const test = await call(testRoute.POST, {
      method: 'POST',
      token: 'other',
      params: { providerId: 'runway' },
    });
    expect(test.status).toBe(404);
    const del = await call(keyRoute.DELETE, {
      method: 'DELETE',
      token: 'other',
      params: { providerId: 'runway' },
    });
    expect(del.status).toBe(404);
  });

  it('tests the stored key with the Runway health check and records the result', async () => {
    // Runway GET /v1/organization (https://docs.dev.runwayml.com/api/#tag/Organization).
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ creditBalance: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(testRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { providerId: 'runway' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ healthy: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v1/organization');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer rw-secret-abcd');
    const list = await call(listRoute.GET, { token: 'owner' });
    expect(list.json.credentials).toEqual([
      expect.objectContaining({ lastTestResult: { healthy: true } }),
    ]);
  });

  it('revokes a key (wiped) and audits it', async () => {
    const res = await call(keyRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { providerId: 'runway' },
    });
    expect(res.status).toBe(200);
    expect(res.json.credential).toMatchObject({ state: 'revoked' });
    const row = await db.providerCredential.findFirstOrThrow({
      where: { organisationId: org, providerId: 'runway' },
    });
    expect(row.encryptedKey).toBeNull();
    expect(api.audits.some((a) => a.action === 'studio.byoc.key_revoked')).toBe(true);
  });

  it('sets the per-project override', async () => {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz-1',
        createdByUserId: 'user-1',
        name: 'BYOC override',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    const bad = await call(projectByocRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: project.id },
      body: { mode: 'mine' },
    });
    expect(bad.status).toBe(400);
    const res = await call(projectByocRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: project.id },
      body: { mode: 'platform' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ projectId: project.id, byoc: 'platform' });
    const other = await call(projectByocRoute.PUT, {
      method: 'PUT',
      token: 'other',
      params: { id: project.id },
      body: { mode: 'org' },
    });
    expect(other.status).toBe(404);
    expect(api.audits.some((a) => a.action === 'studio.byoc.project_mode')).toBe(true);
  });
});
