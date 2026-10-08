import { describe, expect, it } from 'vitest';
import type { StudioFormat } from '@/lib/client/format';
import {
  browserTimeZone,
  changeDirection,
  currentWindow,
  engagementMix,
  engagementRate,
  engagementTotal,
  leadingPlatform,
  periodChange,
  rankedSlots,
  slotParts,
} from './analytics-model';
import type { BestTimesResponse } from './types';
import { DEFAULT_DAYS, resolveDays, withDays } from './use-range-param';

const totals = { views: 1_000, watchTimeSec: 60, likes: 40, comments: 5, shares: 3, saves: 2 };
const rows = (values: number[]) => values.map((value) => ({ value }));

describe('headline ratios', () => {
  it('sums engagement and divides by views', () => {
    expect(engagementTotal(totals)).toBe(50);
    expect(engagementRate(totals)).toBe(0.05);
    expect(engagementRate({ ...totals, views: 0 })).toBeNull();
  });

  it('orders the engagement mix largest first', () => {
    expect(engagementMix(totals).map((m) => m.key)).toEqual([
      'likes',
      'comments',
      'shares',
      'saves',
    ]);
    expect(engagementMix({ ...totals, saves: 90 })[0]).toEqual({ key: 'saves', value: 90 });
  });
});

describe('periodChange', () => {
  it('compares the last window with the one before it', () => {
    expect(periodChange(rows([1, 1, 1, 2, 2, 2]), 3)).toEqual({
      current: 6,
      previous: 3,
      change: 1,
    });
    expect(periodChange(rows([4, 4, 1, 1]), 2).change).toBe(-0.75);
  });

  it('gives no change without previous activity or a whole previous window', () => {
    expect(periodChange(rows([0, 0, 5, 5]), 2)).toEqual({ current: 10, previous: 0, change: null });
    expect(periodChange(rows([3, 5, 5]), 2)).toEqual({ current: 10, previous: 0, change: null });
    expect(periodChange([], 7)).toEqual({ current: 0, previous: 0, change: null });
  });

  it('plots only the current window', () => {
    expect(currentWindow([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(currentWindow([1], 7)).toEqual([1]);
  });

  it('calls a change under half a percent level', () => {
    expect(changeDirection(0.004)).toBe('flat');
    expect(changeDirection(-0.004)).toBe('flat');
    expect(changeDirection(0.2)).toBe('up');
    expect(changeDirection(-0.2)).toBe('down');
  });
});

describe('leadingPlatform', () => {
  it('names the platform with the most views and its share', () => {
    expect(
      leadingPlatform({
        tiktok: { publications: 1, views: 300, engagement: 0 },
        youtube: { publications: 1, views: 100, engagement: 0 },
      }),
    ).toEqual({ platform: 'tiktok', views: 300, share: 0.75 });
  });

  it('says nothing for a single platform or no views', () => {
    expect(leadingPlatform({ tiktok: { publications: 1, views: 300, engagement: 0 } })).toBeNull();
    expect(
      leadingPlatform({
        tiktok: { publications: 1, views: 0, engagement: 0 },
        youtube: { publications: 1, views: 0, engagement: 0 },
      }),
    ).toBeNull();
  });
});

describe('best times', () => {
  const base: BestTimesResponse = {
    ok: true,
    data: [
      { weekday: 4, hour: 18, score: 0.5, basis: '' },
      { weekday: 2, hour: 8, score: 1, basis: '' },
    ],
    bestPerDay: [{ weekday: 1, hour: 9, score: 1, basis: 'style memory' }],
    sufficientData: true,
    videos: 12,
    minVideos: 8,
    timezone: 'UTC',
    styleMemory: null,
  };

  it('ranks the slots best first, or the per-day suggestions with little data', () => {
    expect(rankedSlots(base).map((s) => s.weekday)).toEqual([2, 4]);
    expect(rankedSlots({ ...base, sufficientData: false }).map((s) => s.weekday)).toEqual([1]);
    expect(rankedSlots(base, 1)).toHaveLength(1);
    expect(rankedSlots(undefined)).toEqual([]);
  });

  it('words a slot with the locale formatter', () => {
    const f = {
      date: (iso: string, o?: Intl.DateTimeFormatOptions) => `${iso}|${JSON.stringify(o)}`,
    };
    const parts = slotParts({ weekday: 2, hour: 8 }, f as unknown as StudioFormat);
    expect(parts.day).toContain('"weekday":"long"');
    expect(parts.time).toContain('"hour":"2-digit"');
    // 7 January 2024 was a Sunday, so weekday 2 lands on Tuesday the 9th (local time).
    expect(new Date(parts.day.split('|')[0] ?? '').getDay()).toBe(2);
  });

  it('reads the browser time zone', () => {
    expect(browserTimeZone()).toMatch(/\S/);
  });
});

describe('period in the URL', () => {
  it('accepts only the supported windows', () => {
    expect(resolveDays('7')).toBe(7);
    expect(resolveDays('90')).toBe(90);
    expect(resolveDays('14')).toBe(DEFAULT_DAYS);
    expect(resolveDays(null)).toBe(30);
    expect(resolveDays('abc')).toBe(30);
  });

  it('keeps the default out of the URL and other params in it', () => {
    expect(withDays('', 7)).toBe('?days=7');
    expect(withDays('days=7&x=1', 30)).toBe('?x=1');
    expect(withDays('days=7', 30)).toBe('');
    expect(withDays('x=1', 90)).toBe('?x=1&days=90');
  });
});
