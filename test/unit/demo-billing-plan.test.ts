import { beforeEach, describe, expect, it } from 'vitest';
import '../../demo/api/handlers/p18-billing';
import {
  billingOverview,
  cancelPlan,
  changePlan,
  keepCurrentPlan,
  meBilling,
  parseCheckoutIntent,
  previewPlanChange,
  resumePlan,
  setBillingState,
  videoQuota,
} from '../../demo/api/billing-state';
import { demoPricing } from '../../demo/api/handlers/p18-billing';

// Phase 21.5: the demo's per-channel plan mirrors the real API shapes: a sample organisation on
// 3 channels monthly, upgrades now with an amount due, downgrades at the end of the period, cancel
// / resume / keep the current plan, and no cost figures in the customer-facing billing overview.

describe('demo per-channel plan (21.5)', () => {
  beforeEach(() => setBillingState('active_monthly'));

  it('starts on 3 channels, monthly, 24 videos a month and no cost figures', () => {
    const billing = billingOverview(4);
    expect(billing.plan).toMatchObject({
      channels: 3,
      interval: 'month',
      pricePerPeriodPence: 8_700,
    });
    expect(billing.subscription).toMatchObject({
      lookupKey: 'studio_channel_monthly',
      quantity: 3,
    });
    expect(billing.channels?.allowed).toEqual(['tiktok', 'instagram', 'youtube']);
    expect(billing.channels?.blocked).toEqual(['facebook', 'x', 'linkedin']);
    expect(JSON.stringify(billing.usage)).not.toMatch(/cost|spent|cap/i);
    expect(videoQuota().short.limit).toBe(24);
    expect(meBilling().plan).toMatchObject({ channels: 3, interval: 'month' });
  });

  it('serves the new pricing view (per-channel intervals and the HD packs)', () => {
    const pricing = demoPricing();
    expect(pricing.intervals.map((i) => [i.interval, i.unitAmountPence])).toEqual([
      ['week', 950],
      ['month', 2_900],
      ['year', 29_000],
    ]);
    expect(pricing.topUps.map((p) => [p.lookupKey, p.unitAmountPence])).toEqual([
      ['studio_pack_hd5', 1_500],
      ['studio_pack_hd15', 3_900],
    ]);
  });

  it('previews an upgrade with an amount due now and applies it at once', () => {
    const preview = previewPlanChange({ channels: 5, interval: 'month' });
    expect(preview.timing).toBe('now');
    expect(preview.nextPricePence).toBe(14_500);
    expect(preview.dueNowPence).toBeGreaterThan(0);
    expect(preview.dueNowPence).toBeLessThan(5_800);
    expect(changePlan({ channels: 5, interval: 'month' })).toEqual({
      status: 'applied',
      timing: 'now',
    });
    expect(billingOverview(4).plan?.channels).toBe(5);
  });

  it('schedules a downgrade for the end of the period, and keeping the plan drops it', () => {
    const preview = previewPlanChange({ channels: 2, interval: 'month' });
    expect(preview).toMatchObject({ timing: 'period_end', dueNowPence: null });
    const outcome = changePlan({ channels: 2, interval: 'month' });
    expect(outcome.status).toBe('scheduled');
    expect(billingOverview(4).plan?.pending).toMatchObject({ channels: 2, interval: 'month' });
    keepCurrentPlan();
    expect(billingOverview(4).plan?.pending).toBeNull();
    expect(() => keepCurrentPlan()).toThrow(/no scheduled change/i);
  });

  it('cancels at the end of the period, refuses changes until resumed', () => {
    expect(cancelPlan().endsAt).toEqual(expect.any(String));
    expect(billingOverview(4).subscription?.cancelAtPeriodEnd).toBe(true);
    expect(() => changePlan({ channels: 4, interval: 'month' })).toThrow(/resume/i);
    resumePlan();
    expect(billingOverview(4).subscription?.cancelAtPeriodEnd).toBe(false);
  });

  it('reads channel checkout links and refuses tier ones', () => {
    expect(
      parseCheckoutIntent(new URLSearchParams('kind=channels&channels=3&interval=week')),
    ).toEqual({ kind: 'channels', channels: 3, interval: 'week' });
    expect(
      parseCheckoutIntent(new URLSearchParams('kind=channels&channels=7&interval=month')),
    ).toBeNull();
    expect(
      parseCheckoutIntent(new URLSearchParams('kind=subscription&tier=PLUS&interval=year')),
    ).toBeNull();
  });
});
