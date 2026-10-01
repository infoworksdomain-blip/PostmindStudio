import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, VideoAnalytic } from '@prisma/client';
import {
  analyticsCost,
  costWindowStart,
  dailyActivity,
  leaderboardQuery,
  METRICS,
  metricValue,
  timeseriesQuery,
  windowQuery,
} from './analytics';

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

function snap(publicationId: string, day: string, views: number): VideoAnalytic {
  return {
    id: `${publicationId}-${day}`,
    publicationId,
    bucketAt: new Date(`${day}T00:00:00Z`),
    bucketSize: 'day',
    uniqueViewers: null,
    avgWatchTimePct: null,
    clicks: 0,
    retentionCurve: null,
    demographics: null,
    ...counts({ views }),
  };
}

describe('dailyActivity (gaps in daily snapshots)', () => {
  const start = new Date('2026-09-25T00:00:00Z');
  const now = Date.parse('2026-10-01T12:00:00Z');

  it('puts consecutive-day growth on the day it happened', () => {
    const points = dailyActivity(
      [snap('a', '2026-09-27', 100), snap('a', '2026-09-28', 130)],
      [],
      start,
      now,
      'views',
    );
    expect(points.find((p) => p.day === '2026-09-27')?.value).toBe(100);
    expect(points.find((p) => p.day === '2026-09-28')?.value).toBe(30);
    expect(points.some((p) => p.estimated)).toBe(false);
  });

  it('spreads growth over a gap and flags the days as estimated, not all on the first day after it', () => {
    const points = dailyActivity(
      [snap('a', '2026-09-26', 100), snap('a', '2026-09-30', 500)],
      [],
      start,
      now,
      'views',
    );
    const byDay = Object.fromEntries(points.map((p) => [p.day, p]));
    expect(byDay['2026-09-26']?.value).toBe(100);
    expect(
      ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'].map((d) => byDay[d]?.value),
    ).toEqual([100, 100, 100, 100]);
    expect(byDay['2026-09-29']?.estimated).toBe(true);
    expect(byDay['2026-09-26']?.estimated).toBeUndefined();
    expect(points.reduce((t, p) => t + p.value, 0)).toBe(500);
  });

  it('uses the newest snapshot before the window as the base (no whole-total dump)', () => {
    const points = dailyActivity(
      [snap('a', '2026-09-26', 1_050)],
      [snap('a', '2026-09-20', 1_000)],
      start,
      now,
      'views',
    );
    // 50 views over the six days since the 20th; only the in-window days (25th, 26th) are shown.
    expect(points.reduce((t, p) => t + p.value, 0)).toBeLessThan(50);
    expect(points.find((p) => p.day === '2026-09-26')?.estimated).toBe(true);
  });

  it('never goes negative when a platform lowers a count', () => {
    const points = dailyActivity(
      [snap('a', '2026-09-26', 100), snap('a', '2026-09-27', 90)],
      [],
      start,
      now,
      'views',
    );
    expect(points.every((p) => p.value >= 0)).toBe(true);
  });
});

describe('spend window', () => {
  it('covers whole UTC days ending today: exactly the days the chart plots', () => {
    const now = Date.parse('2026-10-01T12:34:00Z');
    expect(costWindowStart(now, 7).toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(costWindowStart(now, 1).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('names projects (null name stays null) and filters the lookup by organisation', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'p1', name: 'Spring offer' }]);
    const db = {
      providerJob: {
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([
            { provider: 'runway', _sum: { costPence: 300 }, _count: { _all: 2 } },
          ])
          .mockResolvedValueOnce([
            { projectId: 'p1', _sum: { costPence: 200 } },
            { projectId: null, _sum: { costPence: 100 } },
          ]),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      videoProject: { findMany },
    } as unknown as PrismaClient;
    const res = await analyticsCost(db, 'org1', 7, Date.parse('2026-10-01T12:00:00Z'));
    expect(res.byProject).toEqual([
      { projectId: 'p1', name: 'Spring offer', costPence: 200 },
      { projectId: null, name: null, costPence: 100 },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['p1'] }, organisationId: 'org1' } }),
    );
  });
});
