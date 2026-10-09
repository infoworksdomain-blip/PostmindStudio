import { describe, expect, it } from 'vitest';
import {
  adminOverrideActive,
  planChoiceOfSubscription,
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
    expect(trialDays({})).toBe(7);
    expect(trialDays({ STUDIO_TRIAL_DAYS: '0' })).toBe(0);
    expect(graceEndsAt(now, {}).toISOString()).toBe('2026-10-06T12:00:00.000Z');
  });

  it('trial state carries the 26.1 allowance (2 HD videos) and the trial caps', () => {
    expect(trialStateFor(now, null)).toMatchObject({
      shortVideos: 2,
      longVideos: 0,
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
      tier: 'ENTERPRISE' as const,
      access: 'full' as const,
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

  it('20.27: an active staff override pauses the trial; a trial staff ended never returns', () => {
    const trial = trialStateFor(now, new Date('2026-10-10T00:00:00Z'));
    const derived = { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' };
    const admin = {
      tier: 'PLUS' as const,
      reason: 'operator',
      setByUserId: 'staff-1',
      setAt: now.toISOString(),
      expiresAt: '2026-10-01T00:00:00Z',
    };
    const overridden = resolveStoredEntitlements(row({ derived, trial, admin }), now);
    expect(overridden).toMatchObject({ tier: 'PLUS', source: 'admin' });
    expect(overridden.trial).toBeUndefined();
    // The override expired while Stripe still trials: the trial caps come back.
    const later = new Date('2026-10-02T00:00:00Z');
    expect(resolveStoredEntitlements(row({ derived, trial, admin }), later).trial).toEqual(trial);
    // Ended by staff: no trial, with or without the override, and the trial tier's catalogue.
    const ended = { ...trial, endedAt: now.toISOString(), endedByUserId: 'staff-1' };
    expect(resolveStoredEntitlements(row({ derived, trial: ended, admin }), later)).toMatchObject({
      tier: 'STANDARD',
      source: 'trial',
    });
    expect(resolveStoredEntitlements(row({ derived, trial: ended }), later).trial).toBeUndefined();
    expect(parseOverrides({ trial: ended }).trial?.endedAt).toBe(now.toISOString());
  });

  it('falls back to the columns and ignores malformed JSON (never trusted)', () => {
    expect(parseOverrides('nonsense')).toEqual({});
    expect(parseOverrides({ admin: { tier: 'GOLD' } })).toEqual({});
    const ent = resolveStoredEntitlements(row({ derived: 42 }, { access: 'weird' }), now);
    expect(ent).toMatchObject({ tier: 'PLUS', access: 'none', source: 'stripe' });
  });
});

describe('26.1 plan entitlements (Starter / Growth / Pro)', () => {
  const facts = (status: string, lookupKey: string, quantity = 1): SubscriptionFacts => ({
    status,
    lookupKey,
    productTier: null,
    trialEnd: null,
    quantity,
  });
  const derive = (subscription: SubscriptionFacts) =>
    entitlementsFromSubscription({ subscription, now, graceUntil: null, everPaid: true });

  it('a plan price is STANDARD with its plan and interval', () => {
    for (const [key, plan, interval] of [
      ['studio_starter_weekly', 'starter', 'week'],
      ['studio_growth_monthly', 'growth', 'month'],
      ['studio_pro_yearly', 'pro', 'year'],
    ] as const)
      expect(derive(facts('active', key))).toMatchObject({
        tier: 'STANDARD',
        access: 'full',
        plan: { plan, interval },
      });
    expect(derive(facts('trialing', 'studio_growth_monthly'))).toMatchObject({
      tier: 'STANDARD',
      source: 'trial',
      plan: { plan: 'growth', interval: 'month' },
    });
  });

  it('back-compat: a 21.5 channel price maps by quantity (1 → starter, 2–3 → growth, 4+ → pro)', () => {
    expect(derive(facts('active', 'studio_channel_monthly', 1)).plan).toEqual({
      plan: 'starter',
      interval: 'month',
    });
    expect(derive(facts('active', 'studio_channel_weekly', 3)).plan).toEqual({
      plan: 'growth',
      interval: 'week',
    });
    expect(derive(facts('past_due', 'studio_channel_yearly', 4)).plan).toEqual({
      plan: 'pro',
      interval: 'year',
    });
    expect(planChoiceOfSubscription({ lookupKey: 'studio_channel_monthly', quantity: 0 })).toEqual({
      plan: 'starter',
      interval: 'month',
    });
  });

  it('legacy tier prices and ended subscriptions have no plan', () => {
    expect(derive(sub('active')).plan).toBeNull();
    expect(derive(facts('canceled', 'studio_pro_monthly')).plan).toBeNull();
  });

  const stored = (overrides: unknown): StoredEntitlement => ({
    organisationId: 'org-1',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    graceUntil: null,
    overrides,
    everPaidAt: now,
  });
  const derived = {
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: 'growth',
    interval: 'month',
  } as const;

  it('reads the stored plan and interval; seats and businesses follow the plan', () => {
    const ent = resolveStoredEntitlements(stored({ derived }), now);
    expect(ent.plan).toEqual({ id: 'growth', interval: 'month', source: 'stripe' });
    expect(ent.limits).toEqual({ seats: 3, businesses: 1, storageGb: 100 });
    const pro = resolveStoredEntitlements(stored({ derived: { ...derived, plan: 'pro' } }), now);
    expect(pro.limits).toMatchObject({ seats: 10, businesses: 3 });
    const starter = resolveStoredEntitlements(
      stored({ derived: { ...derived, plan: 'starter' } }),
      now,
    );
    expect(starter.limits).toMatchObject({ seats: 1, businesses: 1 });
  });

  it('a 21.5 row that stored channels reads as the mapped plan', () => {
    const legacy = { ...derived, plan: undefined, channels: 5 };
    expect(resolveStoredEntitlements(stored({ derived: legacy }), now).plan).toEqual({
      id: 'pro',
      interval: 'month',
      source: 'stripe',
    });
  });

  it('a staff override sets the plan and / or interval; custom limits still win', () => {
    const admin = {
      plan: 'pro' as const,
      reason: 'goodwill',
      setByUserId: 'staff-1',
      setAt: now.toISOString(),
      expiresAt: null,
    };
    const ent = resolveStoredEntitlements(stored({ derived, admin }), now);
    expect(ent.plan).toEqual({ id: 'pro', interval: 'month', source: 'admin' });
    expect(ent.limits).toMatchObject({ seats: 10, businesses: 3 });
    expect(
      resolveStoredEntitlements(
        stored({
          derived: { ...derived, plan: undefined, interval: undefined },
          admin: { ...admin, interval: 'week' },
        }),
        now,
      ).plan,
    ).toEqual({ id: 'pro', interval: 'week', source: 'admin' });
    // A 21.5 override stored channels: read as a plan.
    const legacyAdmin = { ...admin, plan: undefined, channels: 2 };
    expect(resolveStoredEntitlements(stored({ derived, admin: legacyAdmin }), now).plan?.id).toBe(
      'growth',
    );
    const custom = resolveStoredEntitlements(
      stored({ derived, admin, limits: { seats: 25 } }),
      now,
    );
    expect(custom.limits).toMatchObject({ seats: 25, businesses: 3 });
    const expired = { ...admin, expiresAt: '2026-09-01T00:00:00Z' };
    expect(resolveStoredEntitlements(stored({ derived, admin: expired }), now).plan?.id).toBe(
      'growth',
    );
  });

  it('ENTERPRISE (staff tier) has no plan; nothing stored means none', () => {
    const admin = {
      tier: 'ENTERPRISE' as const,
      reason: 'deal',
      setByUserId: 'staff-1',
      setAt: now.toISOString(),
      expiresAt: null,
    };
    expect(resolveStoredEntitlements(stored({ derived, admin }), now).plan).toBeUndefined();
    expect(
      resolveStoredEntitlements(
        stored({
          derived: { tier: 'STANDARD', access: 'full', source: 'stripe', status: 'active' },
        }),
        now,
      ).plan,
    ).toBeUndefined();
  });
});
