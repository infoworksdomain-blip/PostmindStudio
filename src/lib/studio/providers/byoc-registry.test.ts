import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createLocalKeyProvider, encryptSecret } from '../crypto/envelope';
import { byocKeyContext, setCredential } from '../services/provider-credentials';
import type { ProviderKeyMap } from './byoc-providers';
import {
  BYOC_REGISTRY_CACHE_MS,
  createByocRegistryResolver,
  overlayRegistry,
} from './byoc-registry';
import type { ProviderAdapter } from './interface';
import { createProviderRegistry } from './registry';

const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');
const ON = { STUDIO_BYOC_ENABLED: 'true' };

function adapter(providerId: string, owner: string): ProviderAdapter {
  return {
    providerId,
    capabilities: ['text_to_video'],
    owner,
  } as unknown as ProviderAdapter;
}

const platform = createProviderRegistry([
  adapter('runway', 'platform'),
  adapter('luma', 'platform'),
]);

async function row(organisationId: string, providerId: string, apiKey: string) {
  return {
    organisationId,
    providerId,
    encryptedKey: await encryptSecret(
      keys,
      apiKey,
      byocKeyContext({ organisationId, providerId, kind: 'primary' }),
    ),
    encryptedSecondaryKey: null,
  };
}

function fakeDb(input: {
  rows: Array<Awaited<ReturnType<typeof row>>>;
  projectMetadata?: Record<string, unknown> | null;
}) {
  const findMany = vi.fn(async ({ where }: { where: { organisationId: string } }) =>
    input.rows.filter((r) => r.organisationId === where.organisationId),
  );
  const findFirst = vi.fn(async () =>
    input.projectMetadata === undefined ? null : { metadata: input.projectMetadata },
  );
  const db = {
    providerCredential: { findMany },
    videoProject: { findFirst },
  } as unknown as PrismaClient;
  return { db, findMany };
}

const build = vi.fn((map: ProviderKeyMap) =>
  Object.entries(map).map(([id, key]) => adapter(id, `org:${key?.apiKey ?? ''}`)),
);

const ownerOf = (a: ProviderAdapter | undefined) => (a as unknown as { owner: string }).owner;

describe('overlayRegistry', () => {
  it('replaces same-id platform adapters and keeps the rest', () => {
    const reg = overlayRegistry(platform, [adapter('runway', 'org')]);
    expect(ownerOf(reg.findAdapter('runway'))).toBe('org');
    expect(ownerOf(reg.findAdapter('luma'))).toBe('platform');
    expect(reg.list()).toHaveLength(2);
  });
});

describe('createByocRegistryResolver', () => {
  it('returns undefined when BYOC is disabled (no key lookup)', async () => {
    const { db, findMany } = fakeDb({ rows: [await row('o1', 'runway', 'rw-key-1')] });
    const resolve = createByocRegistryResolver({ db, keys, platformRegistry: platform, env: {} });
    expect(await resolve({ organisationId: 'o1' })).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
    resolve.dispose();
  });

  it('returns undefined for an organisation without active keys', async () => {
    const { db } = fakeDb({ rows: [] });
    const resolve = createByocRegistryResolver({
      db,
      keys,
      platformRegistry: platform,
      env: ON,
      buildAdapters: build,
    });
    expect(await resolve({ organisationId: 'o1' })).toBeUndefined();
    resolve.dispose();
  });

  it('overlays the organisation’s adapters built from its decrypted keys', async () => {
    const { db } = fakeDb({ rows: [await row('o1', 'runway', 'rw-key-1')] });
    const resolve = createByocRegistryResolver({
      db,
      keys,
      platformRegistry: platform,
      env: ON,
      buildAdapters: build,
    });
    const reg = await resolve({ organisationId: 'o1' });
    expect(ownerOf(reg?.findAdapter('runway'))).toBe('org:rw-key-1');
    expect(ownerOf(reg?.findAdapter('luma'))).toBe('platform');
    expect(build).toHaveBeenLastCalledWith({ runway: { apiKey: 'rw-key-1' } }, ON);
    resolve.dispose();
  });

  it('honours the project opt-out and the recorded plan tier', async () => {
    const rows = [await row('o1', 'runway', 'rw-key-1')];
    const optedOut = fakeDb({ rows, projectMetadata: { byoc: 'platform' } });
    const r1 = createByocRegistryResolver({
      db: optedOut.db,
      keys,
      platformRegistry: platform,
      env: ON,
      buildAdapters: build,
    });
    expect(await r1({ organisationId: 'o1', projectId: 'p1' })).toBeUndefined();
    r1.dispose();

    const downgraded = fakeDb({ rows, projectMetadata: { planTier: 'PLUS' } });
    const r2 = createByocRegistryResolver({
      db: downgraded.db,
      keys,
      platformRegistry: platform,
      env: ON,
      buildAdapters: build,
    });
    expect(await r2({ organisationId: 'o1', projectId: 'p1' })).toBeUndefined();
    r2.dispose();

    const enterprise = fakeDb({ rows, projectMetadata: { planTier: 'ENTERPRISE', byoc: 'org' } });
    const r3 = createByocRegistryResolver({
      db: enterprise.db,
      keys,
      platformRegistry: platform,
      env: ON,
      buildAdapters: build,
    });
    expect(await r3({ organisationId: 'o1', projectId: 'p1' })).toBeDefined();
    r3.dispose();
  });

  it('caches per organisation for 60 s and drops the entry on a key change', async () => {
    let now = 1_000;
    const { db, findMany } = fakeDb({ rows: [await row('o1', 'runway', 'rw-key-1')] });
    const resolve = createByocRegistryResolver({
      db,
      keys,
      platformRegistry: platform,
      env: ON,
      now: () => now,
      buildAdapters: build,
    });
    const first = await resolve({ organisationId: 'o1' });
    expect(await resolve({ organisationId: 'o1' })).toBe(first);
    expect(findMany).toHaveBeenCalledTimes(1);
    now += BYOC_REGISTRY_CACHE_MS;
    await resolve({ organisationId: 'o1' });
    expect(findMany).toHaveBeenCalledTimes(2);

    // A key change in this process (setCredential notifies) invalidates the cache.
    const upsert = vi.fn(async () => ({
      providerId: 'luma',
      hint: '1234',
      state: 'active',
      lastTestedAt: null,
      lastTestResult: null,
      updatedAt: new Date(now),
    }));
    await setCredential(
      { db: { providerCredential: { upsert } } as unknown as PrismaClient, keys, env: ON },
      {
        userId: 'u',
        organisationId: 'o1',
        organisation: { id: 'o1', planTier: 'ENTERPRISE' },
        memberships: [],
        capabilities: [],
      },
      'luma',
      { apiKey: 'lm-key-1234' },
    );
    await resolve({ organisationId: 'o1' });
    expect(findMany).toHaveBeenCalledTimes(3);
    resolve.invalidate();
    await resolve({ organisationId: 'o1' });
    expect(findMany).toHaveBeenCalledTimes(4);
    resolve.dispose();
  });
});
