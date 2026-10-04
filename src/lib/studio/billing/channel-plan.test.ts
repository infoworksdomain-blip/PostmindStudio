import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  allowancePerPeriod,
  allowancePerWindow,
  allowanceWindowFor,
  assertChannelCount,
  calendarMonthWindow,
  CHANNEL_LOOKUP_KEYS,
  CHANNEL_PRICE_PENCE,
  channelCostCapsPence,
  channelIntervalForLookupKey,
  channelPlanPricePence,
  isoWeekWindow,
  isValidChannelCount,
  isWeekWindowKey,
  maxVideosPerCalendarMonth,
  planChangeTiming,
  roundUpToStep,
  weeklyPricePerChannelPence,
  yearlyPricePerChannelPence,
} from './channel-plan';

describe('channel plan prices (21.5)', () => {
  it('monthly is the flat £29 per channel', () => {
    expect(CHANNEL_PRICE_PENCE.month).toBe(2_900);
    expect(channelPlanPricePence(1, 'month')).toBe(2_900);
    expect(channelPlanPricePence(6, 'month')).toBe(17_400);
  });

  it('weekly is monthly ÷ 4 × 1.3 rounded UP to the next 50p: £9.425 → £9.50', () => {
    expect((2_900 / 4) * 1.3).toBeCloseTo(942.5);
    expect(weeklyPricePerChannelPence()).toBe(950);
    expect(CHANNEL_PRICE_PENCE.week).toBe(950);
    expect(channelPlanPricePence(3, 'week')).toBe(2_850);
    // Deliberately dearer than monthly over a month of four weeks.
    expect(CHANNEL_PRICE_PENCE.week * 4).toBeGreaterThan(CHANNEL_PRICE_PENCE.month);
  });

  it('the rounding step never rounds down and leaves exact multiples alone', () => {
    expect(roundUpToStep(901, 50)).toBe(950);
    expect(roundUpToStep(950, 50)).toBe(950);
    expect(roundUpToStep(950.0000000001, 50)).toBe(950);
    expect(roundUpToStep(1, 50)).toBe(50);
    expect(() => roundUpToStep(10, 0)).toThrow(RangeError);
    // Another monthly rate goes through the same rule.
    expect(weeklyPricePerChannelPence(3_000)).toBe(1_000); // 975 → 1000
  });

  it('yearly is 10 × monthly, paid upfront (2 months free)', () => {
    expect(yearlyPricePerChannelPence()).toBe(29_000);
    expect(CHANNEL_PRICE_PENCE.year).toBe(29_000);
    expect(channelPlanPricePence(2, 'year')).toBe(58_000);
    expect(CHANNEL_PRICE_PENCE.month * 12 - CHANNEL_PRICE_PENCE.year).toBe(5_800);
  });

  it('uses the live Stripe unit amount when given', () => {
    expect(channelPlanPricePence(3, 'month', 3_100)).toBe(9_300);
  });

  it('accepts 1–6 whole channels only', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) expect(isValidChannelCount(n)).toBe(true);
    for (const n of [0, 7, -1, 2.5, Number.NaN]) {
      expect(isValidChannelCount(n)).toBe(false);
      expect(() => assertChannelCount(n)).toThrow(ValidationError);
    }
    expect(isValidChannelCount('3')).toBe(false);
  });

  it('maps lookup keys to intervals and back', () => {
    expect(CHANNEL_LOOKUP_KEYS).toEqual({
      week: 'studio_channel_weekly',
      month: 'studio_channel_monthly',
      year: 'studio_channel_yearly',
    });
    expect(channelIntervalForLookupKey('studio_channel_weekly')).toBe('week');
    expect(channelIntervalForLookupKey('studio_channel_yearly')).toBe('year');
    expect(channelIntervalForLookupKey('studio_standard_monthly')).toBeUndefined();
    expect(channelIntervalForLookupKey(null)).toBeUndefined();
  });
});

describe('channel plan allowance', () => {
  it('8 videos per channel a month, 2 a week, 96 a year', () => {
    expect(allowancePerPeriod(1, 'month')).toBe(8);
    expect(allowancePerPeriod(3, 'month')).toBe(24);
    expect(allowancePerPeriod(2, 'week')).toBe(4);
    expect(allowancePerPeriod(1, 'year')).toBe(96);
  });

  it('yearly is released as 8 per calendar month; weekly per ISO week', () => {
    expect(allowancePerWindow(1, 'year')).toBe(8);
    expect(allowancePerWindow(6, 'year')).toBe(48);
    expect(allowancePerWindow(4, 'week')).toBe(8);
    expect(allowancePerWindow(4, 'month')).toBe(32);
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
    // Sunday 4 October 2026 belongs to the week starting Monday 28 September (W40).
    const w = isoWeekWindow(Date.parse('2026-10-04T23:59:59Z'));
    expect(w).toEqual({
      key: '2026-W40',
      start: new Date('2026-09-28T00:00:00Z'),
      end: new Date('2026-10-05T00:00:00Z'),
    });
    expect(isoWeekWindow(Date.parse('2026-10-05T00:00:00Z')).key).toBe('2026-W41');
    // 1 Jan 2026 is a Thursday: week 1 of 2026 starts on Monday 29 December 2025.
    expect(isoWeekWindow(Date.parse('2026-01-01T10:00:00Z'))).toMatchObject({
      key: '2026-W01',
      start: new Date('2025-12-29T00:00:00Z'),
    });
    // 31 Dec 2024 (Tuesday) is in week 1 of 2025.
    expect(isoWeekWindow(Date.parse('2024-12-31T10:00:00Z')).key).toBe('2025-W01');
    // 1 Jan 2027 (Friday) is in week 53 of 2026.
    expect(isoWeekWindow(Date.parse('2027-01-01T10:00:00Z')).key).toBe('2026-W53');
    expect(isWeekWindowKey('2026-W40')).toBe(true);
    expect(isWeekWindowKey('2026-10')).toBe(false);
    expect(allowanceWindowFor('week', Date.parse('2026-10-04T00:00:00Z')).key).toBe('2026-W40');
    expect(allowanceWindowFor('month', Date.parse('2026-10-04T00:00:00Z')).key).toBe('2026-10');
  });
});

describe('internal cost caps scale with channels', () => {
  it('allowance × 241p a short (Seedance 2.0 full, 720p) + 25 % headroom; daily is half', () => {
    expect(channelCostCapsPence(1, 'month')).toEqual({ monthlyPence: 2_410, dailyPence: 1_205 });
    expect(channelCostCapsPence(6, 'month')).toEqual({ monthlyPence: 14_460, dailyPence: 7_230 });
    expect(channelCostCapsPence(1, 'year')).toEqual(channelCostCapsPence(1, 'month'));
    // A weekly plan can touch five ISO weeks in one calendar month.
    expect(maxVideosPerCalendarMonth(1, 'week')).toBe(10);
    expect(channelCostCapsPence(1, 'week')).toEqual({ monthlyPence: 3_013, dailyPence: 1_507 });
  });

  it('every cap covers the whole allowance at the typical 241p a short and stays below the price', () => {
    for (const interval of ['week', 'month', 'year'] as const) {
      for (let channels = 1; channels <= 6; channels += 1) {
        const caps = channelCostCapsPence(channels, interval);
        expect(caps.monthlyPence).toBeGreaterThanOrEqual(
          maxVideosPerCalendarMonth(channels, interval) * 241,
        );
      }
    }
    // Monthly: the cap (£24.10 a channel) is below the £29 the channel pays.
    expect(channelCostCapsPence(1, 'month').monthlyPence).toBeLessThan(CHANNEL_PRICE_PENCE.month);
  });
});

describe('plan change timing (upgrades now, downgrades at period end)', () => {
  const at = (channels: number, interval: 'week' | 'month' | 'year') => ({ channels, interval });

  it('no change', () => {
    expect(planChangeTiming(at(3, 'month'), at(3, 'month'))).toBe('none');
  });

  it('more channels on the same interval applies now; fewer at period end', () => {
    expect(planChangeTiming(at(2, 'month'), at(3, 'month'))).toBe('now');
    expect(planChangeTiming(at(3, 'month'), at(2, 'month'))).toBe('period_end');
    expect(planChangeTiming(at(1, 'week'), at(6, 'week'))).toBe('now');
  });

  it('a longer interval applies now; a shorter one at period end', () => {
    expect(planChangeTiming(at(3, 'week'), at(3, 'month'))).toBe('now');
    expect(planChangeTiming(at(3, 'month'), at(3, 'year'))).toBe('now');
    expect(planChangeTiming(at(6, 'month'), at(1, 'year'))).toBe('now');
    expect(planChangeTiming(at(3, 'year'), at(3, 'month'))).toBe('period_end');
    expect(planChangeTiming(at(1, 'month'), at(6, 'week'))).toBe('period_end');
  });
});
