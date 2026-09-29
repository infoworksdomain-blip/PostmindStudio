import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  capabilityMatches,
  hasCapability,
  requireCapability,
  requirePlatformStaff,
  StudioCapability,
} from './rbac';

describe('capabilityMatches', () => {
  it('matches exact grants', () => {
    expect(capabilityMatches('studio:project:read', StudioCapability.ProjectRead)).toBe(true);
    expect(capabilityMatches('studio:project:write', StudioCapability.ProjectRead)).toBe(false);
  });

  it('expands trailing wildcards to everything beneath the prefix', () => {
    expect(capabilityMatches('studio:admin:*', StudioCapability.AdminKillSwitchWrite)).toBe(true);
    expect(capabilityMatches('studio:*', StudioCapability.RenderForceApprove)).toBe(true);
    expect(capabilityMatches('studio:admin:*', StudioCapability.ProjectWrite)).toBe(false);
  });

  it('does not treat other patterns as wildcards', () => {
    expect(capabilityMatches('*', StudioCapability.ProjectRead)).toBe(false);
    expect(capabilityMatches('studio:proj*', StudioCapability.ProjectRead)).toBe(false);
    expect(capabilityMatches('engagement:*', StudioCapability.ProjectRead)).toBe(false);
  });
});

describe('requireCapability', () => {
  const ctx = { capabilities: ['studio:project:read', 'studio:admin:*'] };

  it('passes when the capability is granted', () => {
    expect(() => requireCapability(ctx, StudioCapability.ProjectRead)).not.toThrow();
    expect(hasCapability(ctx, StudioCapability.AdminLibrary)).toBe(true);
  });

  it('throws ForbiddenError naming the missing capability', () => {
    expect(() => requireCapability(ctx, StudioCapability.RenderForceApprove)).toThrow(
      ForbiddenError,
    );
    try {
      requireCapability(ctx, StudioCapability.ProjectWrite);
    } catch (err) {
      expect((err as ForbiddenError).details).toEqual({ capability: 'studio:project:write' });
    }
  });

  it('denies everything when no capabilities are granted', () => {
    expect(hasCapability({ capabilities: [] }, StudioCapability.ProjectRead)).toBe(false);
  });
});

describe('requirePlatformStaff', () => {
  const ctx = { organisationId: 'org-postmind' };

  it('allows any organisation outside production when STUDIO_PLATFORM_ORG_IDS is unset', () => {
    expect(() => requirePlatformStaff(ctx, {})).not.toThrow();
    expect(() => requirePlatformStaff(ctx, { NODE_ENV: 'development' })).not.toThrow();
    expect(() => requirePlatformStaff(ctx, { NODE_ENV: 'test' })).not.toThrow();
  });

  it('refuses every organisation in production when STUDIO_PLATFORM_ORG_IDS is unset', () => {
    expect(() => requirePlatformStaff(ctx, { NODE_ENV: 'production' })).toThrow(ForbiddenError);
  });

  it('refuses in production even when STUDIO_PLATFORM_ORG_IDS is only whitespace/empty entries', () => {
    expect(() =>
      requirePlatformStaff(ctx, { NODE_ENV: 'production', STUDIO_PLATFORM_ORG_IDS: ' , ,' }),
    ).toThrow(ForbiddenError);
  });

  it('allows an organisation listed in STUDIO_PLATFORM_ORG_IDS', () => {
    expect(() =>
      requirePlatformStaff(ctx, {
        NODE_ENV: 'production',
        STUDIO_PLATFORM_ORG_IDS: 'org-a,org-postmind,org-b',
      }),
    ).not.toThrow();
  });

  it('trims whitespace around listed organisation ids', () => {
    expect(() =>
      requirePlatformStaff(ctx, { STUDIO_PLATFORM_ORG_IDS: ' org-a , org-postmind , org-b ' }),
    ).not.toThrow();
  });

  it('refuses an organisation not in the list', () => {
    expect(() => requirePlatformStaff(ctx, { STUDIO_PLATFORM_ORG_IDS: 'org-a,org-b' })).toThrow(
      ForbiddenError,
    );
  });

  it('refuses a non-listed organisation regardless of NODE_ENV', () => {
    expect(() =>
      requirePlatformStaff(ctx, {
        NODE_ENV: 'development',
        STUDIO_PLATFORM_ORG_IDS: 'org-a,org-b',
      }),
    ).toThrow(ForbiddenError);
  });

  it('defaults to process.env when no env override is given', () => {
    const original = process.env.STUDIO_PLATFORM_ORG_IDS;
    process.env.STUDIO_PLATFORM_ORG_IDS = 'org-postmind';
    try {
      expect(() => requirePlatformStaff(ctx)).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.STUDIO_PLATFORM_ORG_IDS;
      else process.env.STUDIO_PLATFORM_ORG_IDS = original;
    }
  });
});

describe('requirePlatformStaff in standalone mode (Phase 18 §2.5)', () => {
  const base = { organisationId: 'org-customer' };

  it('allows staff and superadmins whose 2FA-gated admin capabilities are present', () => {
    expect(() =>
      requirePlatformStaff(
        { ...base, platformRole: 'staff', capabilities: ['studio:admin:library'] },
        { NODE_ENV: 'production' },
      ),
    ).not.toThrow();
    expect(() =>
      requirePlatformStaff({
        ...base,
        platformRole: 'superadmin',
        capabilities: ['studio:admin:*'],
      }),
    ).not.toThrow();
  });

  it('refuses ordinary users even outside production and ignores the org-id list', () => {
    expect(() =>
      requirePlatformStaff(
        { organisationId: 'org-postmind', platformRole: 'user', capabilities: [] },
        { STUDIO_PLATFORM_ORG_IDS: 'org-postmind' },
      ),
    ).toThrow(ForbiddenError);
  });

  it('refuses staff without two-factor authentication', () => {
    try {
      requirePlatformStaff({ ...base, platformRole: 'superadmin', capabilities: [] });
      expect.unreachable();
    } catch (err) {
      expect((err as ForbiddenError).details).toEqual({ reason: 'two_factor_required' });
    }
  });
});
