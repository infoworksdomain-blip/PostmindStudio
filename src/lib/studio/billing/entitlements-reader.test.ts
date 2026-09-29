import { describe, expect, it } from 'vitest';
import { prisma } from '../../prisma';
import { entitlementsReaderFromEnv, NO_PLAN_ENTITLEMENTS } from './entitlements-reader';
import { sharedEntitlementsReader } from './wiring';

// Phase 18 integration: auth/server.ts (Better Auth membershipLimit) and the standalone
// IdentityProvider read seat limits through entitlementsReaderFromEnv, so in Stripe mode it must
// be Track C's real reader, not the Track 0 stub.

describe('entitlementsReaderFromEnv', () => {
  it("returns Track C's shared reader in Stripe billing mode (the standalone default)", async () => {
    const reader = await entitlementsReaderFromEnv({});
    expect(reader).toBe(sharedEntitlementsReader(prisma));
    expect(await entitlementsReaderFromEnv({ STUDIO_BILLING: 'stripe' })).toBe(reader);
  });

  it('returns the no-plan stub when Core owns billing', async () => {
    const reader = await entitlementsReaderFromEnv({ STUDIO_MODE: 'core' });
    expect(reader).not.toBe(sharedEntitlementsReader(prisma));
    await expect(reader.forOrganisation('org-1')).resolves.toBe(NO_PLAN_ENTITLEMENTS);
  });
});
