import type { OrganisationBeta } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import {
  applyBetaPlan,
  BETA_DEFAULT_PLUS_DAYS,
  betaCohortInput,
  createBetaPlanLookup,
  effectivePlanTier,
  plusActive,
  putBeta,
} from './beta';

// BACKLOG 14.11 — beta cohort + "Plus for 30 days" override (pure parts and the service against a
// fake table; test/api/beta-programme.test.ts covers the routes on a real database).

const NOW = Date.parse('2026-10-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const future = { plusUntil: new Date(NOW + DAY) };
const past = { plusUntil: new Date(NOW - 1) };

const tenantWith = (planTier?: string): TenantContext => ({
  userId: 'u1',
  organisationId: 'org-1',
  organisation: { id: 'org-1', planTier },
  memberships: [{ organisationId: 'org-1', role: 'owner' }],
  capabilities: [],
});

const row = (over: Partial<OrganisationBeta> = {}): OrganisationBeta => ({
  organisationId: 'org-1',
  cohort: 'beta-1',
  plusUntil: new Date(NOW + 10 * DAY),
  enrolledAt: new Date(NOW - DAY),
  updatedByUserId: 'staff-1',
  updatedAt: new Date(NOW - DAY),
  ...over,
});

function fakeDb(initial: OrganisationBeta | null = null) {
  let stored = initial;
  return {
    organisationBeta: {
      findUnique: vi.fn(async () => stored),
      upsert: vi.fn(
        async (args: { create: Partial<OrganisationBeta>; update: Partial<OrganisationBeta> }) =>
          (stored = row({ ...(stored ?? args.create), ...args.update, updatedAt: new Date(NOW) })),
      ),
    },
  };
}

describe('effectivePlanTier', () => {
  it('raises BASIC / STANDARD / unknown to PLUS while the override is active', () => {
    expect(effectivePlanTier('BASIC', future, NOW)).toBe('PLUS');
    expect(effectivePlanTier('standard', future, NOW)).toBe('PLUS');
    expect(effectivePlanTier(undefined, future, NOW)).toBe('PLUS');
  });

  it('never lowers a higher tier and ends at plusUntil', () => {
    expect(effectivePlanTier('ENTERPRISE', future, NOW)).toBe('ENTERPRISE');
    expect(effectivePlanTier('STANDARD', past, NOW)).toBe('STANDARD');
    expect(effectivePlanTier('STANDARD', { plusUntil: new Date(NOW) }, NOW)).toBe('STANDARD');
    expect(effectivePlanTier('STANDARD', { plusUntil: null }, NOW)).toBe('STANDARD');
    expect(effectivePlanTier('STANDARD', null, NOW)).toBe('STANDARD');
    expect(plusActive(null, NOW)).toBe(false);
  });
});

describe('applyBetaPlan', () => {
  const lookup = (value: { plusUntil: Date | null } | null) => ({
    find: vi.fn(async () => value),
    invalidate: vi.fn(),
  });

  it('returns a new tenant with planTier PLUS and leaves the input untouched', async () => {
    const tenant = tenantWith('STANDARD');
    const next = await applyBetaPlan(lookup(future), tenant, NOW);
    expect(next.organisation.planTier).toBe('PLUS');
    expect(tenant.organisation.planTier).toBe('STANDARD');
    expect(next).not.toBe(tenant);
  });

  it('is a no-op without a lookup, without a row, after expiry or for higher tiers', async () => {
    const tenant = tenantWith('STANDARD');
    expect(await applyBetaPlan(undefined, tenant, NOW)).toBe(tenant);
    expect(await applyBetaPlan(lookup(null), tenant, NOW)).toBe(tenant);
    expect(await applyBetaPlan(lookup(past), tenant, NOW)).toBe(tenant);
    const enterprise = tenantWith('ENTERPRISE');
    expect(await applyBetaPlan(lookup(future), enterprise, NOW)).toBe(enterprise);
    const plus = tenantWith('plus');
    expect(await applyBetaPlan(lookup(future), plus, NOW)).toBe(plus);
  });
});

describe('createBetaPlanLookup', () => {
  it('caches per organisation for the TTL and refetches after invalidate', async () => {
    let now = NOW;
    const findUnique = vi.fn(async () => future);
    const lookup = createBetaPlanLookup({
      db: { organisationBeta: { findUnique } } as never,
      logger: { warn: vi.fn() },
      now: () => now,
      ttlMs: 1_000,
    });
    await lookup.find('org-1');
    await lookup.find('org-1');
    expect(findUnique).toHaveBeenCalledTimes(1);
    now += 1_001;
    await lookup.find('org-1');
    expect(findUnique).toHaveBeenCalledTimes(2);
    lookup.invalidate('org-1');
    await lookup.find('org-1');
    expect(findUnique).toHaveBeenCalledTimes(3);
  });

  it('falls back to no override (Core tier) and logs when the table cannot be read', async () => {
    const warn = vi.fn();
    const lookup = createBetaPlanLookup({
      db: {
        organisationBeta: {
          findUnique: vi.fn(async () => {
            throw new Error('db down');
          }),
        },
      } as never,
      logger: { warn },
      now: () => NOW,
    });
    expect(await lookup.find('org-1')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('betaCohortInput / putBeta', () => {
  it('validates the cohort name and refuses unknown fields', () => {
    expect(betaCohortInput.safeParse({ cohort: 'beta-1' }).success).toBe(true);
    expect(betaCohortInput.safeParse({ cohort: 'Beta 1' }).success).toBe(false);
    expect(betaCohortInput.safeParse({ cohort: '' }).success).toBe(false);
    expect(betaCohortInput.safeParse({ cohort: 'b', tier: 'PLUS' }).success).toBe(false);
    expect(betaCohortInput.safeParse({ cohort: 'b', plusUntil: 'tomorrow' }).success).toBe(false);
  });

  it('enrols with Plus for 30 days by default', async () => {
    const db = fakeDb();
    const { before, after } = await putBeta(
      db as never,
      'org-1',
      { cohort: 'beta-1' },
      'staff-1',
      NOW,
    );
    expect(before).toBeNull();
    expect(after.plusUntil).toBe(new Date(NOW + BETA_DEFAULT_PLUS_DAYS * DAY).toISOString());
    expect(after.plusActive).toBe(true);
  });

  it('keeps plusUntil when omitted on update, clears it with null', async () => {
    const existing = row();
    const db = fakeDb(existing);
    const kept = await putBeta(db as never, 'org-1', { cohort: 'beta-2' }, 'staff-1', NOW);
    expect(kept.after.plusUntil).toBe(existing.plusUntil?.toISOString());
    expect(kept.after.cohort).toBe('beta-2');
    const cleared = await putBeta(
      db as never,
      'org-1',
      { cohort: 'beta-2', plusUntil: null },
      's',
      NOW,
    );
    expect(cleared.after).toMatchObject({ plusUntil: null, plusActive: false });
  });

  it('refuses a past or too-distant plusUntil and a bad organisation id', async () => {
    const db = fakeDb();
    await expect(
      putBeta(
        db as never,
        'org-1',
        { cohort: 'b', plusUntil: new Date(NOW - DAY).toISOString() },
        's',
        NOW,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      putBeta(
        db as never,
        'org-1',
        { cohort: 'b', plusUntil: new Date(NOW + 400 * DAY).toISOString() },
        's',
        NOW,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(putBeta(db as never, ' ', { cohort: 'b' }, 's', NOW)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
