import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../errors';
import {
  accountRefInput,
  assertRefreshed,
  MAX_REFRESH_BATCH,
  refreshedTokensInput,
  registerMetaChannelInput,
} from './meta-channels';

// Schema-level rules; the database behaviour is covered in test/api/internal-channels.test.ts.

const valid = {
  organisationId: 'org-1',
  platform: 'instagram',
  platformAccountId: '17841400000000001',
  platformAccountName: '@cafe',
  accessToken: 'EAAGxxxxxxxxxxxxxxxxxxxx',
};

describe('registerMetaChannelInput', () => {
  it('accepts Engagement-style bodies and defaults scopes', () => {
    const parsed = registerMetaChannelInput.parse({ ...valid, extraCoreField: 1 });
    expect(parsed.scopes).toEqual([]);
    expect(parsed).not.toHaveProperty('extraCoreField');
    expect(
      registerMetaChannelInput.safeParse({
        ...valid,
        platform: 'facebook',
        tokenExpiresAt: '2026-11-26T00:00:00Z',
        businessId: 'biz-1',
        scopes: ['pages_manage_posts'],
      }).success,
    ).toBe(true);
    expect(registerMetaChannelInput.safeParse({ ...valid, tokenExpiresAt: null }).success).toBe(
      true,
    );
  });

  it('rejects non-Meta platforms, non-numeric Graph ids and malformed tokens', () => {
    for (const bad of [
      { platform: 'tiktok' },
      { platformAccountId: 'ig-123' },
      { accessToken: 'short' },
      { accessToken: 'has whitespace in the middle of it' },
      { accessToken: 'x'.repeat(4_097) },
      { tokenExpiresAt: 'tomorrow' },
      { organisationId: '' },
    ])
      expect(registerMetaChannelInput.safeParse({ ...valid, ...bad }).success).toBe(false);
  });
});

describe('refreshedTokensInput', () => {
  const item = {
    organisationId: 'org-1',
    platform: 'facebook',
    platformAccountId: '100000000000001',
    accessToken: 'EAAGyyyyyyyyyyyyyyyyyyyy',
  };

  it('accepts one token or a bounded batch', () => {
    expect(refreshedTokensInput.safeParse(item).success).toBe(true);
    expect(refreshedTokensInput.safeParse({ channels: [item, item] }).success).toBe(true);
    expect(refreshedTokensInput.safeParse({ channels: [] }).success).toBe(false);
    expect(
      refreshedTokensInput.safeParse({
        channels: Array.from({ length: MAX_REFRESH_BATCH + 1 }, () => item),
      }).success,
    ).toBe(false);
  });
});

describe('accountRefInput / assertRefreshed', () => {
  it('needs all three account keys', () => {
    expect(accountRefInput.safeParse({ organisationId: 'o', platform: 'instagram' }).success).toBe(
      false,
    );
  });

  it('maps single-token outcomes to 404 / 409', () => {
    const base = { organisationId: 'o', platform: 'instagram', platformAccountId: '1' };
    expect(() => assertRefreshed({ ...base, result: 'updated' })).not.toThrow();
    expect(() => assertRefreshed({ ...base, result: 'not_found' })).toThrow(NotFoundError);
    expect(() => assertRefreshed({ ...base, result: 'revoked' })).toThrow(ConflictError);
  });
});
