import { describe, expect, it } from 'vitest';
import { aggregateBestTimes, bestTimesQuery } from './best-times';

describe('aggregateBestTimes (15.A6)', () => {
  const at = (iso: string, views: number) => ({ publishedAt: new Date(iso), views });

  it('scores weekday/hour slots by mean views relative to the best slot', () => {
    const result = aggregateBestTimes(
      [
        at('2026-09-01T08:10:00Z', 1000), // Tue 08
        at('2026-09-08T08:40:00Z', 600), // Tue 08
        at('2026-09-02T18:00:00Z', 400), // Wed 18
      ],
      'UTC',
    );
    expect(result.videos).toBe(3);
    expect(result.slots[0]).toEqual({ weekday: 2, hour: 8, score: 1, basis: '2 videos' });
    expect(result.slots[1]).toEqual({ weekday: 3, hour: 18, score: 0.5, basis: '1 video' });
    expect(result.bestPerDay.map((s) => s.weekday)).toEqual([2, 3]);
  });

  it('buckets in the viewer time zone', () => {
    const result = aggregateBestTimes([at('2026-09-01T23:30:00Z', 10)], 'Europe/London');
    expect(result.slots[0]).toMatchObject({ weekday: 3, hour: 0 });
  });

  it('handles no data and zero views', () => {
    expect(aggregateBestTimes([], 'UTC')).toEqual({ slots: [], bestPerDay: [], videos: 0 });
    expect(aggregateBestTimes([at('2026-09-01T08:00:00Z', 0)], 'UTC').slots[0]?.score).toBe(0);
  });

  it('validates the query', () => {
    expect(bestTimesQuery.parse({}).timezone).toBe('UTC');
    expect(bestTimesQuery.safeParse({ timezone: 'Bad/Zone' }).success).toBe(false);
    expect(bestTimesQuery.safeParse({ platform: 'myspace' }).success).toBe(false);
    expect(bestTimesQuery.safeParse({ language: 'fr' }).success).toBe(true);
    expect(bestTimesQuery.safeParse({ language: 'not a tag' }).success).toBe(false);
  });
});
