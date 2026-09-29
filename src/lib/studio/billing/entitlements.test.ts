import { describe, expect, it } from 'vitest';
import {
  adminOverrideActive,
  entitlementsFromSubscription,
  graceDays,
  graceEndsAt,
  parseOverrides,
  resolveStoredEntitlements,
  tierOfSubscription,
  trialDays,
  trialStateFor,
  type StoredEntitlement,
  type SubscriptionFacts,
} from './entitlements';

const now = new Date('2026-09-29T12:00:00Z');
const sub = (
  status: string,
  lookupKey: string | null = 'studio_plus_monthly',
): SubscriptionFacts => ({
  status,
  lookupKey,
  productTier: null,
  trialEnd: null,
});
const inGrace = new Date('2026-10-02T00:00:00Z');
const graceOver = new Date('2026-09-28T00:00:00Z');

describe('entitlementsFromSubscription (§P.3 status table)', () => {
  const cases: Array<
    [
      string,
      SubscriptionFacts | null,
      { graceUntil?: Date | null; everPaid?: boolean },
      string,
      string,
      string,
    ]
  > = [
    ['trialing', sub('trialing'), {}, 'STANDARD', 'full', 'trial'],
    ['active', sub('active'), {}, 'PLUS', 'full', 'stripe'],
    ['past_due within grace', sub('past_due'), { graceUntil: inGrace }, 'PLUS', 'full', 'stripe'],
    [
      'past_due, grace not started',
      sub('past_due'),
      { graceUntil: null },
      'PLUS',
      'full',
      'stripe',
    ],
    [
      'past_due after grace',
      sub('past_due'),
      { graceUntil: graceOver },
      'PLUS',
      'read_only',
      'stripe',
    ],
    ['unpaid', sub('unpaid'), {}, 'PLUS', 'read_only', 'stripe'],
    ['canceled, never paid', sub('canceled'), {}, 'BASIC', 'none', 'none'],
    ['canceled after paying', sub('canceled'), { everPaid: true }, 'BASIC', 'read_only', 'none'],
    ['incomplete', sub('incomplete'), {}, 'BASIC', 'none', 'none'],
    ['incomplete_expired', sub('incomplete_expired'), {}, 'BASIC', 'none', 'none'],
    [
      'incomplete_expired after paying',
      sub('incomplete_expired'),
      { everPaid: true },
      'BASIC',
      'read_only',
      'none',
    ],
    ['paused, never paid', sub('paused'), {}, 'PLUS', 'none', 'stripe'],
    ['paused after paying', sub('paused'), { everPaid: true }, 'PLUS', 'read_only', 'stripe'],
    ['no subscription', null, {}, 'BASIC', 'none', 'none'],
    ['no subscription after paying', null, { everPaid: true }, 'BASIC', 'read_only', 'none'],
    ['a status Stripe adds later', sub('something_new'), {}, 'BASIC', 'none', 'none'],
  ];
  for (const [name, subscription, opts, tier, access, source] of cases) {
    it(`${name} → ${tier} / ${access}`, () => {
      const out = entitlementsFromSubscription({
        subscription,
        now,
        graceUntil: opts.graceUntil ?? null,
        everPaid: opts.everPaid ?? false,
      });
      expect(out).toMatchObject({ tier, access, source });
      expect(out.status).toBe(subscription?.status ?? null);
    });
  }

  it('maps ENTERPRISE by product metadata when the price has no lookup key', () => {
    expect(tierOfSubscription({ lookupKey: null, productTier: 'enterprise' })).toBe('ENTERPRISE');
    expect(tierOfSubscription({ lookupKey: 'studio_basic_yearly', productTier: null })).toBe(
      'BASIC',
    );
    expect(tierOfSubscription({ lookupKey: 'unknown', productTier: 'nonsense' })).toBeUndefined();
    const out = entitlementsFromSubscription({
      subscription: {
        status: 'active',
        lookupKey: null,
        productTier: 'ENTERPRISE',
        trialEnd: null,
      },
      now,
      graceUntil: null,
      everPaid: true,
    });
    expect(out.tier).toBe('ENTERPRISE');
  });

  it('an active subscription with an unknown price falls back to BASIC, never above', () => {
    expect(
      entitlementsFromSubscription({
        subscription: sub('active', 'studio_mystery'),
        now,
        graceUntil: null,
        everPaid: false,
      }).tier,
    ).toBe('BASIC');
  });
});

describe('grace and trial settings', () => {
  it('reads STUDIO_BILLING_GRACE_DAYS and STUDIO_TRIAL_DAYS with safe fallbacks', () => {
    expect(graceDays({})).toBe(7);
    expect(graceDays({ STUDIO_BILLING_GRACE_DAYS: '3' })).toBe(3);
    expect(graceDays({ STUDIO_BILLING_GRACE_DAYS: 'x' })).toBe(7);
    expect(graceDays({ STUDIO_BILLING_GRACE_DAYS: '99' })).toBe(7);
    expect(trialDays({})).toBe(14);
    expect(trialDays({ STUDIO_TRIAL_DAYS: '0' })).toBe(0);
    expect(graceEndsAt(now, {}).toISOString()).toBe('2026-10-06T12:00:00.000Z');
  });

  it('trial state carries the §P.1 allowance and caps', () => {
    expect(trialStateFor(now, null)).toMatchObject({
      shortVideos: 5,
      longVideos: 1,
      dailyCostCapPence: 1_000,
      totalCostCapPence: 1_500,
      endsAt: null,
    });
  });
});

describe('resolveStoredEntitlements', () => {
  const row = (overrides: unknown, extra: Partial<StoredEntitlement> = {}): StoredEntitlement => ({
    organisationId: 'org-1',
    tier: 'PLUS',
    access: 'full',
    source: 'stripe',
    graceUntil: null,
    overrides,
    everPaidAt: null,
    ...extra,
  });

  it('past_due turns read_only when the stored grace ends, with no event', () => {
    const stored = row(
      { derived: { tier: 'PLUS', access: 'full', source: 'stripe', status: 'past_due' } },
      { graceUntil: new Date('2026-09-30T00:00:00Z') },
    );
    expect(resolveStoredEntitlements(stored, now)).toMatchObject({
      access: 'full',
      graceUntil: new Date('2026-09-30T00:00:00Z'),
    });
    expect(resolveStoredEntitlements(stored, new Date('2026-09-30T00:00:01Z')).access).toBe(
      'read_only',
    );
  });

  it('an unexpired admin override wins; an expired one does not', () => {
    const admin = {
      tier: 'ENTERPRISE',
      access: 'full',
      reason: 'contract',
      setByUserId: 'staff-1',
      setAt: now.toISOString(),
      expiresAt: '2026-10-01T00:00:00Z',
    };
    const stored = row({
      derived: { tier: 'BASIC', access: 'none', source: 'none', status: null },
      admin,
      limits: { seats: 50, businesses: null, shortVideos: 500 },
    });
    const active = resolveStoredEntitlements(stored, now);
    expect(active).toMatchObject({ tier: 'ENTERPRISE', access: 'full', source: 'admin' });
    expect(active.limits).toEqual({ seats: 50, businesses: null, storageGb: null });
    expect(active.custom?.shortVideos).toBe(500);
    const expired = resolveStoredEntitlements(stored, new Date('2026-10-02T00:00:00Z'));
    expect(expired).toMatchObject({ tier: 'BASIC', access: 'none', source: 'none' });
    expect(expired.custom).toBeUndefined();
    expect(adminOverrideActive(undefined, now)).toBe(false);
    expect(adminOverrideActive({ ...admin, expiresAt: 'not a date' }, now)).toBe(false);
    expect(adminOverrideActive({ ...admin, expiresAt: null }, now)).toBe(true);
  });

  it('a trialing organisation gets the trial allowance; catalogue limits otherwise', () => {
    const trial = trialStateFor(now, null);
    const stored = row({
      derived: { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' },
      trial,
    });
    const ent = resolveStoredEntitlements(stored, now);
    expect(ent.trial).toEqual(trial);
    expect(ent.limits).toEqual({ seats: 5, businesses: 3, storageGb: 100 });
    expect(ent.subscriptionStatus).toBe('trialing');
  });

  it('falls back to the columns and ignores malformed JSON (never trusted)', () => {
    expect(parseOverrides('nonsense')).toEqual({});
    expect(parseOverrides({ admin: { tier: 'GOLD' } })).toEqual({});
    const ent = resolveStoredEntitlements(row({ derived: 42 }, { access: 'weird' }), now);
    expect(ent).toMatchObject({ tier: 'PLUS', access: 'none', source: 'stripe' });
  });
});
