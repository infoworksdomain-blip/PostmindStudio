import { describe, expect, it } from 'vitest';
import type { Publication } from '@/lib/client/types';
import {
  dayKey,
  eventTime,
  gridWindow,
  groupByDay,
  groupOpenByDay,
  monthGrid,
  shiftMonth,
} from './month';

const base = {
  projectId: 'prj',
  renderId: 'ren',
  platform: 'tiktok',
  platformAccountId: 'acc',
  platformPostId: null,
  platformUrl: null,
  caption: null,
  hashtags: [],
  errorReason: null,
  errorCode: null,
  retryCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
};

function pub(id: string, state: string, scheduledFor: string | null, publishedAt: string | null) {
  return { ...base, id, state, scheduledFor, publishedAt } as Publication;
}

describe('month helpers', () => {
  it('builds Monday-first whole weeks covering the month', () => {
    const days = monthGrid({ year: 2026, month: 8 }); // September 2026 starts on a Tuesday
    expect(days.length % 7).toBe(0);
    expect(days[0]!.getDay()).toBe(1);
    expect(dayKey(days[0]!)).toBe('2026-08-31');
    expect(days.some((d) => dayKey(d) === '2026-09-30')).toBe(true);
    expect(days.at(-1)!.getDay()).toBe(0);
  });

  it('wraps months across years', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });

  it('gives a window from the first grid day to the day after the last', () => {
    const { from, to } = gridWindow({ year: 2026, month: 8 });
    expect(new Date(from).getTime()).toBe(new Date(2026, 7, 31).getTime());
    expect(new Date(to).getTime()).toBe(new Date(2026, 9, 5).getTime());
  });

  it('places a publication on its published day, else its scheduled day, sorted by time', () => {
    const a = pub('a', 'SCHEDULED', new Date(2026, 8, 3, 15).toISOString(), null);
    const b = pub(
      'b',
      'PUBLISHED',
      new Date(2026, 8, 1).toISOString(),
      new Date(2026, 8, 3, 9).toISOString(),
    );
    const c = pub('c', 'SCHEDULED', null, null);
    expect(eventTime(b)).toBe(b.publishedAt);
    const byDay = groupByDay([a, b, c]);
    expect(byDay.get('2026-09-03')!.map((p) => p.id)).toEqual(['b', 'a']);
    expect(byDay.has('2026-09-01')).toBe(false);
    expect([...byDay.values()].flat()).toHaveLength(2);
  });
});

describe('open slots by day (20.3)', () => {
  it('buckets open slot instants by local day, in time order', () => {
    const a = new Date(2026, 9, 5, 18, 0).toISOString();
    const b = new Date(2026, 9, 5, 9, 0).toISOString();
    const c = new Date(2026, 9, 6, 12, 30).toISOString();
    const byDay = groupOpenByDay([a, c, b]);
    expect(byDay.get('2026-10-05')).toEqual([b, a]);
    expect(byDay.get('2026-10-06')).toEqual([c]);
    expect(groupOpenByDay([]).size).toBe(0);
  });
});
