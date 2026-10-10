import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  allowancePerWindow,
  allowanceWindowFor,
  assertPlanChoice,
  blendedAllowance,
  calendarMonthWindow,
  isoWeekWindow,
  isPlanId,
  isPlanInterval,
  isWeekWindowKey,
  LEGACY_CHANNEL_LOOKUP_KEYS,
  legacyChannelIntervalForLookupKey,
  maxVideosPerCalendarMonth,
  PLAN_IDS,
  PLAN_INTERVALS,
  planChangeTiming,
  planChoiceForLookupKey,
  planCostCapsPence,
  planForChannelCount,
  planLookupKey,
  planLookupKeys,
  planOfSubscription,
  planPricePence,
  planProductId,
  roundUpToStep,
  STUDIO_PLANS,
  weeklyPricePence,
  yearlyPricePence,
  type PlanId,
  type PlanInterval,
} from './plans';

describe('plan prices (26.1)', () => {
  it('monthly: Starter £29, Growth £69, Pro £149', () => {
    expect(planPricePence('starter', 'month')).toBe(2_900);
    expect(planPricePence('growth', 'month')).toBe(6_900);
    expect(planPricePence('pro', 'month')).toBe(14_900);
  });

  it('weekly is monthly ÷ 4 × 1.3 rounded UP to the next 50p', () => {
    // 942.5 → 950, 2242.5 → 2250, 4842.5 → 4850
    expect(planPricePence('starter', 'week')).toBe(950);
    expect(planPricePence('growth', 'week')).toBe(2_250);
    expect(planPricePence('pro', 'week')).toBe(4_850);
    for (const plan of PLAN_IDS)
      // Deliberately dearer than monthly over a month of four weeks.
      expect(planPricePence(plan, 'week') * 4).toBeGreaterThan(planPricePence(plan, 'month'));
  });

  it('the rounding step never rounds down and leaves exact multiples alone', () => {
    expect(roundUpToStep(901, 50)).toBe(950);
    expect(roundUpToStep(950, 50)).toBe(950);
    expect(roundUpToStep(950.0000000001, 50)).toBe(950);
    expect(roundUpToStep(1, 50)).toBe(50);
    expect(() => roundUpToStep(10, 0)).toThrow(RangeError);
    expect(weeklyPricePence(3_000)).toBe(1_000); // 975 → 1000
  });

  it('yearly is 10 × monthly, paid upfront (2 months free)', () => {
    expect(planPricePence('starter', 'year')).toBe(29_000);
    expect(planPricePence('growth', 'year')).toBe(69_000);
    expect(planPricePence('pro', 'year')).toBe(149_000);
    expect(yearlyPricePence(100)).toBe(1_000);
  });

  it('limits per plan: businesses and seats', () => {
    expect(STUDIO_PLANS.starter).toMatchObject({ businesses: 1, seats: 1 });
    expect(STUDIO_PLANS.growth).toMatchObject({ businesses: 1, seats: 3 });
    expect(STUDIO_PLANS.pro).toMatchObject({ businesses: 3, seats: 10 });
  });
});

describe('lookup keys and products', () => {
  it('one product per plan, studio_<plan>_<weekly|monthly|yearly> keys', () => {
    expect(planLookupKey('growth', 'week')).toBe('studio_growth_weekly');
    expect(planLookupKey('pro', 'year')).toBe('studio_pro_yearly');
    expect(planProductId('starter')).toBe('studio_plan_starter');
    expect(planLookupKeys()).toHaveLength(9);
    expect(new Set(planLookupKeys()).size).toBe(9);
  });

  it('maps keys back to plan and interval; other keys are not plans', () => {
    for (const plan of PLAN_IDS)
      for (const interval of PLAN_INTERVALS)
        expect(planChoiceForLookupKey(planLookupKey(plan, interval))).toEqual({ plan, interval });
    expect(planChoiceForLookupKey('studio_standard_monthly')).toBeUndefined();
    expect(planChoiceForLookupKey('studio_channel_monthly')).toBeUndefined();
    expect(planChoiceForLookupKey(null)).toBeUndefined();
  });

  it('validates a plan choice', () => {
    expect(isPlanId('growth')).toBe(true);
    expect(isPlanId('basic')).toBe(false);
    expect(isPlanInterval('year')).toBe(true);
    expect(isPlanInterval('day')).toBe(false);
    expect(assertPlanChoice({ plan: 'pro', interval: 'week' })).toEqual({
      plan: 'pro',
      interval: 'week',
    });
    expect(() => assertPlanChoice({ plan: 'enterprise', interval: 'month' })).toThrow(
      ValidationError,
    );
    expect(() => assertPlanChoice({ plan: 'pro', interval: 'quarter' })).toThrow(ValidationError);
  });
});

describe('legacy per-channel subscriptions (21.5 → 26.1)', () => {
  it('maps channels to a plan: 1 → starter, 2–3 → growth, 4+ → pro', () => {
    expect(planForChannelCount(1)).toBe('starter');
    expect(planForChannelCount(2)).toBe('growth');
    expect(planForChannelCount(3)).toBe('growth');
    expect(planForChannelCount(4)).toBe('pro');
    expect(planForChannelCount(6)).toBe('pro');
    expect(planForChannelCount(9)).toBe('pro');
    expect(planForChannelCount(0)).toBe('starter');
  });

  it('reads a subscription on a channel price by its quantity and interval', () => {
    expect(LEGACY_CHANNEL_LOOKUP_KEYS.month).toBe('studio_channel_monthly');
    expect(legacyChannelIntervalForLookupKey('studio_channel_weekly')).toBe('week');
    expect(planOfSubscription({ lookupKey: 'studio_channel_yearly', quantity: 3 })).toEqual({
      plan: 'growth',
      interval: 'year',
      legacy: true,
    });
    expect(planOfSubscription({ lookupKey: 'studio_channel_monthly', quantity: null })).toEqual({
      plan: 'starter',
      interval: 'month',
      legacy: true,
    });
    expect(planOfSubscription({ lookupKey: 'studio_pro_monthly', quantity: 1 })).toEqual({
      plan: 'pro',
      interval: 'month',
      legacy: false,
    });
    expect(planOfSubscription({ lookupKey: 'studio_plus_monthly' })).toBeNull();
    expect(planOfSubscription({ lookupKey: null })).toBeNull();
  });
});

describe('allowance per window', () => {
  it('monthly and yearly per calendar month; weekly per ISO week', () => {
    const table: Array<[PlanId, PlanInterval, number]> = [
      ['starter', 'month', 8],
      ['growth', 'month', 20],
      ['pro', 'month', 45],
      ['starter', 'year', 8],
      ['growth', 'year', 20],
      ['pro', 'year', 45],
      ['starter', 'week', 2],
      ['growth', 'week', 5],
      ['pro', 'week', 11],
    ];
    for (const [plan, interval, videos] of table)
      expect(allowancePerWindow(plan, interval)).toBe(videos);
  });

  it('calendar-month windows match the existing engine', () => {
    const w = calendarMonthWindow(Date.parse('2026-10-04T12:00:00Z'));
    expect(w).toEqual({
      key: '2026-10',
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('ISO weeks run Monday 00:00 UTC to the next Monday, keyed YYYY-Www', () => {
    const w = isoWeekWindow(Date.parse('2026-10-04T23:59:59Z'));
    expect(w).toEqual({
      key: '2026-W40',
      start: new Date('2026-09-28T00:00:00Z'),
      end: new Date('2026-10-05T00:00:00Z'),
    });
    expect(isoWeekWindow(Date.parse('2026-10-05T00:00:00Z')).key).toBe('2026-W41');
    expect(isoWeekWindow(Date.parse('2026-01-01T10:00:00Z'))).toMatchObject({
      key: '2026-W01',
      start: new Date('2025-12-29T00:00:00Z'),
    });
    expect(isoWeekWindow(Date.parse('2024-12-31T10:00:00Z')).key).toBe('2025-W01');
    expect(isoWeekWindow(Date.parse('2027-01-01T10:00:00Z')).key).toBe('2026-W53');
    expect(isWeekWindowKey('2026-W40')).toBe(true);
    expect(isWeekWindowKey('2026-10')).toBe(false);
    expect(allowanceWindowFor('week', Date.parse('2026-10-04T00:00:00Z')).key).toBe('2026-W40');
    expect(allowanceWindowFor('month', Date.parse('2026-10-04T00:00:00Z')).key).toBe('2026-10');
  });
});

describe('internal cost caps scale with the plan', () => {
  it('videos a calendar month × 241p + 25 % headroom; daily is half', () => {
    expect(planCostCapsPence('starter', 'month')).toEqual({
      monthlyPence: 2_410,
      dailyPence: 1_205,
    });
    expect(planCostCapsPence('growth', 'month')).toEqual({
      monthlyPence: 6_025,
      dailyPence: 3_013,
    });
    expect(planCostCapsPence('pro', 'month')).toEqual({ monthlyPence: 13_557, dailyPence: 6_779 });
    expect(planCostCapsPence('pro', 'year')).toEqual(planCostCapsPence('pro', 'month'));
    // A weekly plan can touch five ISO weeks in one calendar month.
    expect(maxVideosPerCalendarMonth('pro', 'week')).toBe(55);
    expect(planCostCapsPence('starter', 'week')).toEqual({
      monthlyPence: 3_013,
      dailyPence: 1_507,
    });
  });

  it('every cap covers the whole allowance at 241p and the monthly cap stays below the price', () => {
    for (const plan of PLAN_IDS) {
      for (const interval of PLAN_INTERVALS)
        expect(planCostCapsPence(plan, interval).monthlyPence).toBeGreaterThanOrEqual(
          maxVideosPerCalendarMonth(plan, interval) * 241,
        );
      expect(planCostCapsPence(plan, 'month').monthlyPence).toBeLessThan(
        planPricePence(plan, 'month'),
      );
    }
  });
});

describe('plan change timing (upgrades now, downgrades at period end)', () => {
  const at = (plan: PlanId, interval: PlanInterval) => ({ plan, interval });

  it('no change', () => {
    expect(planChangeTiming(at('growth', 'month'), at('growth', 'month'))).toBe('none');
  });

  it('a higher plan applies now, whatever the interval; a lower one at period end', () => {
    expect(planChangeTiming(at('starter', 'month'), at('growth', 'month'))).toBe('now');
    expect(planChangeTiming(at('growth', 'year'), at('pro', 'week'))).toBe('now');
    expect(planChangeTiming(at('pro', 'month'), at('growth', 'month'))).toBe('period_end');
    expect(planChangeTiming(at('growth', 'week'), at('starter', 'year'))).toBe('period_end');
  });

  it('same plan: a longer interval applies now; a shorter one at period end', () => {
    expect(planChangeTiming(at('growth', 'week'), at('growth', 'month'))).toBe('now');
    expect(planChangeTiming(at('pro', 'month'), at('pro', 'year'))).toBe('now');
    expect(planChangeTiming(at('starter', 'year'), at('starter', 'month'))).toBe('period_end');
    expect(planChangeTiming(at('pro', 'month'), at('pro', 'week'))).toBe('period_end');
  });
});

describe('blendedAllowance: an upgrade mid-window adds only the remaining share (26.3)', () => {
  const october = calendarMonthWindow(Date.parse('2026-10-10T00:00:00Z'));

  it('Starter -> Pro on the last day of a 31-day month adds 1/31 of the difference, rounded down', () => {
    expect(blendedAllowance(8, 45, october, Date.parse('2026-10-31T00:00:00Z'))).toBe(9);
    expect(blendedAllowance(8, 45, october, Date.parse('2026-10-31T23:00:00Z'))).toBe(8);
  });

  it('half way through the window adds half the difference', () => {
    // 15.5 of 31 days left: 8 + floor(37 / 2) = 26.
    expect(blendedAllowance(8, 45, october, Date.parse('2026-10-16T12:00:00Z'))).toBe(26);
  });

  it('at the start of the window (or a change in an earlier window) the new allowance is whole', () => {
    expect(blendedAllowance(8, 45, october, october.start.getTime())).toBe(45);
    expect(blendedAllowance(8, 45, october, Date.parse('2026-09-30T23:59:00Z'))).toBe(45);
    expect(blendedAllowance(8, 45, october, october.end.getTime())).toBe(45);
  });

  it('never lowers the allowance (a lower plan is not blended) and works on ISO weeks', () => {
    expect(blendedAllowance(45, 8, october, Date.parse('2026-10-20T00:00:00Z'))).toBe(8);
    const week = isoWeekWindow(Date.parse('2026-10-07T00:00:00Z'));
    // Monday 5 Oct to Monday 12 Oct; Friday 00:00 leaves 3 of 7 days: 2 + floor(9 * 3 / 7) = 5.
    expect(blendedAllowance(2, 11, week, Date.parse('2026-10-09T00:00:00Z'))).toBe(5);
  });
});
