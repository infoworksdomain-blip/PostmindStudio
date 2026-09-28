import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FeatureDisabledError, NotFoundError, PlanTierError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { createLocalKeyProvider, decryptSecret } from '../crypto/envelope';
import type { ProviderAdapter } from '../providers/interface';
import {
  assertByocAvailable,
  byocAvailability,
  byocKeyContext,
  listCredentials,
  loadActiveKeys,
  onByocKeysChanged,
  parseProviderId,
  projectByocMode,
  revokeCredential,
  setCredential,
  setCredentialInput,
  setProjectByocMode,
  testCredential,
} from './provider-credentials';

const ON = { STUDIO_BYOC_ENABLED: 'true', HEYGEN_AVATAR_ID: '' };

function tenant(organisationId: string, planTier = 'ENTERPRISE'): TenantContext {
  return {
    userId: 'user-1',
    organisationId,
    organisation: { id: organisationId, planTier },
    memberships: [{ organisationId, role: 'owner' }],
    capabilities: [],
  };
}

describe('BYOC gates', () => {
  it('is unavailable unless STUDIO_BYOC_ENABLED=true', () => {
    expect(byocAvailability(tenant('o'), {})).toEqual({ enabled: false, reason: 'disabled' });
    expect(() => assertByocAvailable(tenant('o'), {})).toThrow(FeatureDisabledError);
  });

  it('needs the Enterprise plan', () => {
    expect(byocAvailability(tenant('o', 'PLUS'), ON)).toEqual({
      enabled: false,
      reason: 'plan_tier',
    });
    expect(() => assertByocAvailable(tenant('o', 'PLUS'), ON)).toThrow(PlanTierError);
    expect(byocAvailability(tenant('o', 'enterprise'), ON)).toEqual({ enabled: true });
  });

  it('validates the key input and provider id', () => {
    expect(setCredentialInput.safeParse({ apiKey: '  short ' }).success).toBe(false);
    expect(setCredentialInput.safeParse({ apiKey: 'x'.repeat(513) }).success).toBe(false);
    expect(setCredentialInput.parse({ apiKey: '  12345678  ' })).toEqual({ apiKey: '12345678' });
    expect(setCredentialInput.safeParse({ apiKey: '12345678', extra: 1 }).success).toBe(false);
    expect(parseProviderId('runway')).toBe('runway');
    expect(() => parseProviderId('suno')).toThrow(NotFoundError);
  });

  it('reads the project override (default org)', () => {
    expect(projectByocMode(null)).toBe('org');
    expect(projectByocMode({ byoc: 'platform' })).toBe('platform');
    expect(projectByocMode({ byoc: 'nonsense' })).toBe('org');
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('provider credentials (database)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');
  const org = `svc-byoc-${randomUUID()}`;
  const deps = { db, keys, env: ON, now: () => Date.parse('2026-09-28T10:00:00Z') };

  afterAll(async () => {
    await db.providerCredential.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('stores the key encrypted, round-trips it and never returns key material', async () => {
    const changed = vi.fn();
    const off = onByocKeysChanged(changed);
    const view = await setCredential(deps, tenant(org), 'runway', { apiKey: 'rw-secret-abcd' });
    off();
    expect(changed).toHaveBeenCalledWith(org);
    expect(view).toMatchObject({ providerId: 'runway', hint: 'abcd', state: 'active' });
    expect(JSON.stringify(view)).not.toContain('rw-secret');
    const row = await db.providerCredential.findFirstOrThrow({
      where: { organisationId: org, providerId: 'runway' },
    });
    expect(row.encryptedKey).not.toContain('rw-secret');
    const plain = await decryptSecret(
      keys,
      row.encryptedKey ?? '',
      byocKeyContext({ organisationId: org, providerId: 'runway', kind: 'primary' }),
    );
    expect(plain).toBe('rw-secret-abcd');
    expect(await loadActiveKeys(db, keys, org)).toEqual({ runway: { apiKey: 'rw-secret-abcd' } });
    const list = await listCredentials(db, org);
    expect(JSON.stringify(list)).not.toContain('rw-secret');
    expect(Object.keys(list[0] ?? {})).not.toContain('encryptedKey');
  });

  it('refuses the wrong shape per provider', async () => {
    await expect(
      setCredential(deps, tenant(org), 'storyblocks', { apiKey: 'public-1234' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      setCredential(deps, tenant(org), 'runway', {
        apiKey: 'rw-secret-abcd',
        secondaryKey: 'extra-1234',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      setCredential(deps, tenant(org), 'heygen', { apiKey: 'hg-secret-1234' }),
    ).rejects.toThrow(/HEYGEN_AVATAR_ID/);
    const sb = await setCredential(deps, tenant(org), 'storyblocks', {
      apiKey: 'public-1234',
      secondaryKey: 'private-5678',
    });
    expect(sb.hint).toBe('1234');
    const loaded = await loadActiveKeys(db, keys, org);
    expect(loaded.storyblocks).toEqual({ apiKey: 'public-1234', secondaryKey: 'private-5678' });
  });

  it('refuses mutations when disabled or not Enterprise', async () => {
    await expect(
      setCredential({ ...deps, env: {} }, tenant(org), 'luma', { apiKey: 'lm-secret-1234' }),
    ).rejects.toThrow(FeatureDisabledError);
    await expect(
      setCredential(deps, tenant(org, 'PLUS'), 'luma', { apiKey: 'lm-secret-1234' }),
    ).rejects.toThrow(PlanTierError);
    expect(
      await db.providerCredential.count({ where: { organisationId: org, providerId: 'luma' } }),
    ).toBe(0);
  });

  it('tests a key with the adapter health check and stores the result', async () => {
    const healthCheck = vi.fn(async () => ({ healthy: false, reason: 'unauthorized' }));
    const buildAdapters = vi.fn(() => [
      { providerId: 'runway', healthCheck } as unknown as ProviderAdapter,
    ]);
    const result = await testCredential({ ...deps, buildAdapters }, tenant(org), 'runway');
    expect(result).toEqual({ healthy: false, reason: 'runway: unauthorized' });
    expect(buildAdapters).toHaveBeenCalledWith({ runway: { apiKey: 'rw-secret-abcd' } }, ON);
    const [view] = (await listCredentials(db, org)).filter((c) => c.providerId === 'runway');
    expect(view?.lastTestResult).toEqual(result);
    expect(view?.lastTestedAt).toBe('2026-09-28T10:00:00.000Z');
    await expect(testCredential({ ...deps, buildAdapters }, tenant(org), 'pexels')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('revoke wipes the key material and re-setting reactivates the row', async () => {
    const view = await revokeCredential(deps, tenant(org), 'runway');
    expect(view.state).toBe('revoked');
    const row = await db.providerCredential.findFirstOrThrow({
      where: { organisationId: org, providerId: 'runway' },
    });
    expect(row.encryptedKey).toBeNull();
    expect(row.encryptedSecondaryKey).toBeNull();
    expect((await loadActiveKeys(db, keys, org)).runway).toBeUndefined();
    await expect(revokeCredential(deps, tenant(org), 'runway')).rejects.toThrow(NotFoundError);
    const again = await setCredential(deps, tenant(org), 'runway', { apiKey: 'rw-second-9999' });
    expect(again).toMatchObject({ state: 'active', hint: '9999', lastTestResult: null });
  });

  it('sets the per-project override on the project metadata', async () => {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz-1',
        createdByUserId: 'user-1',
        name: 'BYOC',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [],
        metadata: { keep: true },
      },
    });
    expect(await setProjectByocMode(deps, tenant(org), project.id, 'platform')).toEqual({
      projectId: project.id,
      byoc: 'platform',
    });
    const stored = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.metadata).toEqual({ keep: true, byoc: 'platform' });
    await expect(setProjectByocMode(deps, tenant('other-org'), project.id, 'org')).rejects.toThrow(
      NotFoundError,
    );
  });
});
