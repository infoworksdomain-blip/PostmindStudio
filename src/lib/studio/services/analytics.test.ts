import { describe, expect, it } from 'vitest';
import { leaderboardQuery, METRICS, metricValue, timeseriesQuery, windowQuery } from './analytics';

// BACKLOG 11.3 / spec 8.7 — pure parts only (metricValue + the zod query schemas). The DB-backed
// query functions (analyticsOverview, analyticsTimeseries, ...) are covered by an integration test.

function counts(
  overrides: Partial<Record<(typeof METRICS)[number] | 'watchTimeSec' | 'saves', number>> = {},
) {
  return {
    views: 0,
    watchTimeSec: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    ...overrides,
  };
}

describe('metricValue', () => {
  it('returns views', () => {
    expect(metricValue(counts({ views: 10 }), 'views')).toBe(10);
  });

  it('returns watchTimeSec for the watchTime metric', () => {
    expect(metricValue(counts({ watchTimeSec: 250 }), 'watchTime')).toBe(250);
  });

  it('returns likes', () => {
    expect(metricValue(counts({ likes: 4 }), 'likes')).toBe(4);
  });

  it('returns comments', () => {
    expect(metricValue(counts({ comments: 7 }), 'comments')).toBe(7);
  });

  it('returns shares', () => {
    expect(metricValue(counts({ shares: 2 }), 'shares')).toBe(2);
  });

  it('sums likes, comments, shares and saves for the engagement metric', () => {
    expect(metricValue(counts({ likes: 1, comments: 2, shares: 3, saves: 4 }), 'engagement')).toBe(
      10,
    );
  });

  it('covers every declared metric without throwing', () => {
    for (const metric of METRICS) {
      expect(() => metricValue(counts(), metric)).not.toThrow();
    }
  });
});

describe('windowQuery', () => {
  it('defaults to 30 days when no input is given', () => {
    expect(windowQuery.parse({})).toEqual({ days: 30 });
  });

  it.each([7, 30, 90])('accepts %d as a valid window', (days) => {
    expect(windowQuery.parse({ days })).toEqual({ days });
  });

  it('coerces a numeric string into a number', () => {
    expect(windowQuery.parse({ days: '7' })).toEqual({ days: 7 });
  });

  it('rejects any value outside 7, 30 or 90', () => {
    expect(() => windowQuery.parse({ days: 14 })).toThrow(/days must be 7, 30 or 90/);
  });

  it('rejects 0', () => {
    expect(() => windowQuery.parse({ days: 0 })).toThrow();
  });

  it('rejects a non-integer', () => {
    expect(() => windowQuery.parse({ days: 30.5 })).toThrow();
  });
});

describe('timeseriesQuery', () => {
  it('defaults to 30 days and the views metric', () => {
    expect(timeseriesQuery.parse({})).toEqual({ days: 30, metric: 'views' });
  });

  it('accepts the minimum of 1 day', () => {
    expect(timeseriesQuery.parse({ days: 1 }).days).toBe(1);
  });

  it('accepts the maximum of 365 days', () => {
    expect(timeseriesQuery.parse({ days: 365 }).days).toBe(365);
  });

  it('rejects 0 days', () => {
    expect(() => timeseriesQuery.parse({ days: 0 })).toThrow();
  });

  it('rejects more than 365 days', () => {
    expect(() => timeseriesQuery.parse({ days: 366 })).toThrow();
  });

  it('accepts any declared metric', () => {
    for (const metric of METRICS) {
      expect(timeseriesQuery.parse({ metric }).metric).toBe(metric);
    }
  });

  it('rejects an unknown metric', () => {
    expect(() => timeseriesQuery.parse({ metric: 'bogus' })).toThrow();
  });
});

describe('leaderboardQuery', () => {
  it('defaults to 30 days, the views metric and a limit of 10', () => {
    expect(leaderboardQuery.parse({})).toEqual({ days: 30, metric: 'views', limit: 10 });
  });

  it('only accepts 7, 30 or 90 for days (inherited from windowQuery)', () => {
    expect(() => leaderboardQuery.parse({ days: 14 })).toThrow();
  });

  it('accepts the minimum limit of 1', () => {
    expect(leaderboardQuery.parse({ limit: 1 }).limit).toBe(1);
  });

  it('accepts the maximum limit of 50', () => {
    expect(leaderboardQuery.parse({ limit: 50 }).limit).toBe(50);
  });

  it('rejects a limit of 0', () => {
    expect(() => leaderboardQuery.parse({ limit: 0 })).toThrow();
  });

  it('rejects a limit above 50', () => {
    expect(() => leaderboardQuery.parse({ limit: 51 })).toThrow();
  });
});
