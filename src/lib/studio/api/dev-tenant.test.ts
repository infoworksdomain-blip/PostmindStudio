import { describe, expect, it } from 'vitest';
import { DEV_CAPABILITIES, devTenantFromEnv } from './dev-tenant';

// STUDIO_DEV_TENANT lets local UI development run without PostMind Core. It must only ever be
// honoured in NODE_ENV=development — never in production or test — so it can't bypass JWT
// verification in a deployed service.

describe('devTenantFromEnv', () => {
  it('returns undefined outside development, even with a valid value set', () => {
    expect(
      devTenantFromEnv({ NODE_ENV: 'production', STUDIO_DEV_TENANT: 'org-1:user-1' }),
    ).toBeUndefined();
    expect(
      devTenantFromEnv({ NODE_ENV: 'test', STUDIO_DEV_TENANT: 'org-1:user-1' }),
    ).toBeUndefined();
    expect(devTenantFromEnv({ STUDIO_DEV_TENANT: 'org-1:user-1' })).toBeUndefined();
  });

  it('returns undefined in development when the variable is unset', () => {
    expect(devTenantFromEnv({ NODE_ENV: 'development' })).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only value', () => {
    expect(devTenantFromEnv({ NODE_ENV: 'development', STUDIO_DEV_TENANT: '' })).toBeUndefined();
    expect(devTenantFromEnv({ NODE_ENV: 'development', STUDIO_DEV_TENANT: '   ' })).toBeUndefined();
  });

  it('builds a full-capability tenant context from "organisationId:userId" in development', () => {
    const tenant = devTenantFromEnv({
      NODE_ENV: 'development',
      STUDIO_DEV_TENANT: 'org-1:user-1',
    });
    expect(tenant).toEqual({
      userId: 'user-1',
      organisationId: 'org-1',
      organisation: { id: 'org-1', name: 'Local development', planTier: 'PLUS' },
      memberships: [{ organisationId: 'org-1', role: 'owner' }],
      capabilities: DEV_CAPABILITIES,
    });
    expect(tenant?.capabilities).toEqual(['studio:*']);
  });

  it('trims whitespace around the organisationId and userId', () => {
    const tenant = devTenantFromEnv({
      NODE_ENV: 'development',
      STUDIO_DEV_TENANT: '  org-1 : user-1  ',
    });
    expect(tenant).toMatchObject({ organisationId: 'org-1', userId: 'user-1' });
  });

  it('ignores malformed values missing the colon separator', () => {
    expect(
      devTenantFromEnv({ NODE_ENV: 'development', STUDIO_DEV_TENANT: 'org-1-user-1' }),
    ).toBeUndefined();
  });

  it('ignores malformed values missing the organisationId', () => {
    expect(
      devTenantFromEnv({ NODE_ENV: 'development', STUDIO_DEV_TENANT: ':user-1' }),
    ).toBeUndefined();
  });

  it('ignores malformed values missing the userId', () => {
    expect(
      devTenantFromEnv({ NODE_ENV: 'development', STUDIO_DEV_TENANT: 'org-1:' }),
    ).toBeUndefined();
  });

  it('uses only the first two colon-separated parts, ignoring extras', () => {
    const tenant = devTenantFromEnv({
      NODE_ENV: 'development',
      STUDIO_DEV_TENANT: 'org-1:user-1:extra',
    });
    expect(tenant).toMatchObject({ organisationId: 'org-1', userId: 'user-1' });
  });

  it('defaults to process.env when no env override is passed (test env is not development)', () => {
    expect(devTenantFromEnv()).toBeUndefined();
  });
});
