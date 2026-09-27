import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import { capabilityMatches, hasCapability, requireCapability, StudioCapability } from './rbac';

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
