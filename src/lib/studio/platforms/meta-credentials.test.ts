import { randomBytes } from 'node:crypto';
import type { PlatformConnection } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '../../errors';
import { createLocalKeyProvider } from '../crypto/envelope';
import { createStoredMetaCredentials } from './meta-credentials';
import { sealTokens } from './tokens';

const keys = createLocalKeyProvider(randomBytes(32).toString('base64'), 'test');
const NOW = Date.parse('2026-09-27T12:00:00Z');
const ref = {
  organisationId: 'org-1',
  platform: 'instagram' as const,
  platformAccountId: '17841400000000001',
};

async function row(overrides: Partial<PlatformConnection> = {}): Promise<PlatformConnection> {
  const sealed = await sealTokens(keys, 'org-1', 'instagram', {
    accessToken: 'EAAG-ig-token',
    scopes: ['instagram_content_publish'],
  });
  return {
    id: 'conn-ig',
    organisationId: 'org-1',
    businessId: null,
    platform: 'instagram',
    platformAccountId: ref.platformAccountId,
    platformAccountName: '@cafe',
    ...sealed,
    scopes: ['instagram_content_publish'],
    state: 'active',
    connectedByUserId: 'system:postmind-core',
    connectedAt: new Date(NOW),
    statusCheckedAt: null,
    statusCheckOutcome: null,
    ...overrides,
  };
}

function db(found: PlatformConnection | null) {
  const findUnique = vi.fn(async () => found);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return {
    db: { platformConnection: { findUnique, updateMany } } as never,
    findUnique,
    updateMany,
  };
}

describe('createStoredMetaCredentials', () => {
  it('decrypts the stored token for the org-scoped account', async () => {
    const fake = db(await row());
    const source = createStoredMetaCredentials({ db: fake.db, keys, now: () => NOW });
    await expect(source.getCredentials(ref)).resolves.toEqual({
      accessToken: 'EAAG-ig-token',
      accountId: ref.platformAccountId,
      accountName: '@cafe',
    });
    expect(fake.findUnique).toHaveBeenCalledWith({
      where: { organisationId_platform_platformAccountId: ref },
    });
  });

  it('cannot decrypt a token sealed for another organisation', async () => {
    const other = await sealTokens(keys, 'org-2', 'instagram', { accessToken: 'x', scopes: [] });
    const fake = db(await row({ encryptedAccessToken: other.encryptedAccessToken }));
    const source = createStoredMetaCredentials({ db: fake.db, keys, now: () => NOW });
    // The encryption context binds the ciphertext to org-2: unwrapping under org-1 fails.
    await expect(source.getCredentials(ref)).rejects.toThrow();
  });

  it('is needs_reconnect when the channel is unknown, revoked or already flagged', async () => {
    for (const found of [
      null,
      await row({ state: 'revoked', encryptedAccessToken: '' }),
      await row({ state: 'needs_reconnect' }),
    ]) {
      const source = createStoredMetaCredentials({ db: db(found).db, keys, now: () => NOW });
      await expect(source.getCredentials(ref)).rejects.toMatchObject({
        errorClass: 'needs_reconnect',
        platform: 'instagram',
      });
    }
  });

  it('marks an expired token needs_reconnect instead of using it', async () => {
    const fake = db(await row({ accessTokenExpiresAt: new Date(NOW - 1) }));
    const source = createStoredMetaCredentials({ db: fake.db, keys, now: () => NOW });
    const err = await source.getCredentials(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { ...ref, state: 'active' },
      data: { state: 'needs_reconnect' },
    });
  });

  it('uses a token that has not expired yet', async () => {
    const fake = db(await row({ accessTokenExpiresAt: new Date(NOW + 60_000) }));
    const source = createStoredMetaCredentials({ db: fake.db, keys, now: () => NOW });
    await expect(source.getCredentials(ref)).resolves.toMatchObject({
      accessToken: 'EAAG-ig-token',
    });
    expect(fake.updateMany).not.toHaveBeenCalled();
  });

  it('reportTokenRejected flags only an active connection', async () => {
    const fake = db(null);
    const source = createStoredMetaCredentials({ db: fake.db, keys, now: () => NOW });
    await source.reportTokenRejected?.(ref);
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { ...ref, state: 'active' },
      data: { state: 'needs_reconnect' },
    });
  });
});
