import { beforeEach, describe, expect, it } from 'vitest';
import '../../demo/api/handlers/p18-billing';
import {
  billingOverview,
  cancelPlan,
  changePlan,
  checkoutHref,
  completeCheckout,
  keepCurrentPlan,
  limits,
  meBilling,
  parseCheckoutIntent,
  previewPlanChange,
  resumePlan,
  setBillingState,
  videoQuota,
} from '../../demo/api/billing-state';
import { demoPricing } from '../../demo/api/handlers/p18-billing';

// Phase 26.1: the demo's tiered plans mirror the real API shapes: a sample organisation on Growth
// monthly, a higher plan applies now with an amount due, a lower plan at the end of the period,
// cancel / resume / keep the current plan, no channel limit and no cost figures in the
// customer-facing billing overview.

describe('demo tiered plans (26.1)', () => {
  beforeEach(() => setBillingState('active_monthly'));

  it('starts on Growth, monthly, 20 videos a month, 3 seats and no cost figures', () => {
    const billing = billingOverview(2);
    expect(billing.plan).toEqual({
      id: 'growth',
      interval: 'month',
      source: 'stripe',
      legacy: false,
      pricePerPeriodPence: 6_900,
      currency: 'gbp',
      pending: null,
      paymentPending: false,
    });
    expect(billing.subscription).toMatchObject({
      lookupKey: 'studio_growth_monthly',
      quantity: 1,
    });
    expect(billing).not.toHaveProperty('channels');
    expect(billing.usage.seats).toEqual({ used: 2, limit: 3 });
    expect(billing.usage.businesses.limit).toBe(1);
    expect(JSON.stringify(billing.usage)).not.toMatch(/cost|spent|cap/i);
    expect(videoQuota().short.limit).toBe(20);
    expect(meBilling().plan).toMatchObject({ studioPlan: 'growth', interval: 'month' });
    expect(meBilling()).not.toHaveProperty('channels');
  });

  it('takes seats and businesses from the plan (Pro: 3 businesses, 10 seats)', () => {
    setBillingState('active_yearly');
    expect(limits()).toMatchObject({ seats: 10, businesses: 3 });
    expect(billingOverview(2).plan).toMatchObject({
      id: 'pro',
      interval: 'year',
      pricePerPeriodPence: 149_000,
    });
    expect(videoQuota().short.limit).toBe(45);
  });

  it('counts a weekly plan per week and the trial as 2 videos', () => {
    setBillingState('active_weekly');
    expect(videoQuota().short.limit).toBe(2);
    expect(billingOverview(1).plan?.pricePerPeriodPence).toBe(950);
    setBillingState('trial');
    expect(videoQuota().short.limit).toBe(2);
  });

  it('serves the tiered pricing view (three plans and the HD packs)', () => {
    const pricing = demoPricing();
    expect(
      pricing.plans.map((p) => [
        p.plan,
        p.mostPopular,
        p.prices.week.unitAmountPence,
        p.prices.month.unitAmountPence,
        p.prices.year.unitAmountPence,
      ]),
    ).toEqual([
      ['starter', false, 950, 2_900, 29_000],
      ['growth', true, 2_250, 6_900, 69_000],
      ['pro', false, 4_850, 14_900, 149_000],
    ]);
    expect(pricing.topUps.map((p) => [p.lookupKey, p.unitAmountPence])).toEqual([
      ['studio_pack_hd5', 1_700],
      ['studio_pack_hd15', 4_500],
    ]);
    expect(pricing.trial).toEqual({ days: 7, videos: 2 });
  });

  it('previews a higher plan with an amount due now and applies it at once', () => {
    const preview = previewPlanChange({ plan: 'pro', interval: 'month' });
    expect(preview.timing).toBe('now');
    expect(preview.current).toEqual({ plan: 'growth', interval: 'month' });
    expect(preview.nextPricePence).toBe(14_900);
    expect(preview.dueNowPence).toBeGreaterThan(0);
    expect(preview.dueNowPence).toBeLessThan(14_900 - 6_900);
    expect(changePlan({ plan: 'pro', interval: 'month' })).toEqual({
      status: 'applied',
      timing: 'now',
    });
    expect(billingOverview(2).plan?.id).toBe('pro');
    expect(limits().seats).toBe(10);
  });

  it('schedules a lower plan for the end of the period, and keeping the plan drops it', () => {
    const preview = previewPlanChange({ plan: 'starter', interval: 'month' });
    expect(preview).toMatchObject({ timing: 'period_end', dueNowPence: null });
    const outcome = changePlan({ plan: 'starter', interval: 'month' });
    expect(outcome.status).toBe('scheduled');
    expect(billingOverview(2).plan?.pending).toMatchObject({ plan: 'starter', interval: 'month' });
    expect(billingOverview(2).plan?.id).toBe('growth');
    keepCurrentPlan();
    expect(billingOverview(2).plan?.pending).toBeNull();
    expect(() => keepCurrentPlan()).toThrow(/no scheduled change/i);
  });

  it('follows planChangeTiming for the interval on the same plan', () => {
    expect(previewPlanChange({ plan: 'growth', interval: 'year' }).timing).toBe('now');
    expect(previewPlanChange({ plan: 'growth', interval: 'week' }).timing).toBe('period_end');
    expect(previewPlanChange({ plan: 'growth', interval: 'month' }).timing).toBe('none');
    expect(() => changePlan({ plan: 'growth', interval: 'month' })).toThrow(/already your plan/i);
  });

  it('cancels at the end of the period, refuses changes until resumed', () => {
    expect(cancelPlan().endsAt).toEqual(expect.any(String));
    expect(billingOverview(2).subscription?.cancelAtPeriodEnd).toBe(true);
    expect(() => changePlan({ plan: 'pro', interval: 'month' })).toThrow(/resume/i);
    resumePlan();
    expect(billingOverview(2).subscription?.cancelAtPeriodEnd).toBe(false);
  });

  it('reads plan checkout links, refuses channel and tier ones, and starts the chosen plan', () => {
    const href = checkoutHref({ kind: 'plan', plan: 'starter', interval: 'week' });
    const search = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(parseCheckoutIntent(search)).toEqual({
      kind: 'plan',
      plan: 'starter',
      interval: 'week',
    });
    expect(
      parseCheckoutIntent(new URLSearchParams('kind=plan&plan=enterprise&interval=month')),
    ).toBeNull();
    expect(
      parseCheckoutIntent(new URLSearchParams('kind=channels&channels=3&interval=month')),
    ).toBeNull();
    expect(
      parseCheckoutIntent(new URLSearchParams('kind=subscription&tier=PLUS&interval=year')),
    ).toBeNull();
    setBillingState('no_plan');
    expect(completeCheckout({ kind: 'plan', plan: 'pro', interval: 'month' })).toBe('checkout');
    expect(billingOverview(1).plan).toMatchObject({ id: 'pro', interval: 'month' });
    expect(billingOverview(1).entitlements.trial?.shortVideos).toBe(2);
  });
});
