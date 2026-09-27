import { describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../../../../test/helpers/fake-fetch';
import { PoliteFetcher, unchangedFrom } from './fetch';
import {
  freshAsOf,
  nextDailyTick,
  nextWeeklyTick,
  RESCAN_INTERVAL_MS,
  RESCAN_SWEEP_PATTERN,
  scanPlanTier,
  scheduleView,
  STOCK_REFRESH_PATTERN,
} from './schedule';

const at = (iso: string) => new Date(iso).getTime();

describe('schedule ticks', () => {
  it('patterns match the tick constants', () => {
    expect(RESCAN_SWEEP_PATTERN).toBe('30 3 * * *');
    expect(STOCK_REFRESH_PATTERN).toBe('0 4 * * 1');
  });

  it('next daily tick is today at 03:30 UTC, or tomorrow once passed', () => {
    expect(nextDailyTick(at('2026-10-01T01:00:00Z')).toISOString()).toBe(
      '2026-10-01T03:30:00.000Z',
    );
    expect(nextDailyTick(at('2026-10-01T03:30:00Z')).toISOString()).toBe(
      '2026-10-01T03:30:00.000Z',
    );
    expect(nextDailyTick(at('2026-10-01T04:00:00Z')).toISOString()).toBe(
      '2026-10-02T03:30:00.000Z',
    );
  });

  it('next weekly tick is the coming Monday 04:00 UTC', () => {
    // 2026-10-01 is a Thursday.
    expect(nextWeeklyTick(at('2026-10-01T12:00:00Z')).toISOString()).toBe(
      '2026-10-05T04:00:00.000Z',
    );
    expect(nextWeeklyTick(at('2026-10-05T03:00:00Z')).toISOString()).toBe(
      '2026-10-05T04:00:00.000Z',
    );
    expect(nextWeeklyTick(at('2026-10-05T05:00:00Z')).toISOString()).toBe(
      '2026-10-12T04:00:00.000Z',
    );
  });

  it('scanPlanTier falls back to STANDARD', () => {
    expect(scanPlanTier('PLUS')).toBe('PLUS');
    expect(scanPlanTier(null)).toBe('STANDARD');
    expect(scanPlanTier('GOLD')).toBe('STANDARD');
  });
});

describe('scheduleView', () => {
  const now = at('2026-10-01T12:00:00Z');
  const completedAt = new Date('2026-09-20T10:00:00Z');

  it('next scan is the first sweep 30 days after the last fresh time', () => {
    const view = scheduleView({
      latest: { state: 'SUCCEEDED', completedAt, checkedUnchangedAt: null },
      lastSuccess: { completedAt, checkedUnchangedAt: null },
      hasProfile: true,
      now,
    });
    expect(view.nextScanAt).toBe(
      nextDailyTick(completedAt.getTime() + RESCAN_INTERVAL_MS).toISOString(),
    );
    expect(view.nextStockRefreshAt).toBe('2026-10-05T04:00:00.000Z');
    expect(view.lastSkippedUnchangedAt).toBeNull();
    expect(view.intervalDays).toBe(30);
  });

  it('an unchanged check pushes the next scan out and is reported', () => {
    const checked = new Date('2026-09-30T03:31:00Z');
    const view = scheduleView({
      latest: { state: 'SUCCEEDED', completedAt, checkedUnchangedAt: checked },
      lastSuccess: { completedAt, checkedUnchangedAt: checked },
      hasProfile: false,
      now,
    });
    expect(view.lastSkippedUnchangedAt).toBe(checked.toISOString());
    expect(view.nextScanAt).toBe(
      nextDailyTick(checked.getTime() + RESCAN_INTERVAL_MS).toISOString(),
    );
    expect(view.nextStockRefreshAt).toBeNull();
  });

  it('overdue scans run at the next sweep; none while a scan runs or before a success', () => {
    const old = new Date('2026-07-01T00:00:00Z');
    expect(
      scheduleView({
        latest: { state: 'SUCCEEDED', completedAt: old, checkedUnchangedAt: null },
        lastSuccess: { completedAt: old, checkedUnchangedAt: null },
        hasProfile: true,
        now,
      }).nextScanAt,
    ).toBe('2026-10-02T03:30:00.000Z');
    expect(
      scheduleView({
        latest: { state: 'RUNNING', completedAt: null, checkedUnchangedAt: null },
        lastSuccess: { completedAt: old, checkedUnchangedAt: null },
        hasProfile: true,
        now,
      }).nextScanAt,
    ).toBeNull();
    expect(
      scheduleView({ latest: null, lastSuccess: null, hasProfile: false, now }).nextScanAt,
    ).toBeNull();
  });

  it('freshAsOf takes the later of completion and the unchanged check', () => {
    expect(freshAsOf({ completedAt, checkedUnchangedAt: null })).toEqual(completedAt);
    expect(freshAsOf({ completedAt: null, checkedUnchangedAt: null })).toBeNull();
  });
});

describe('conditional requests (A6.6 skip-if-unchanged)', () => {
  const previous = { etag: '"v1"', lastModified: 'Tue, 01 Sep 2026 10:00:00 GMT' };

  it('304 with validators = unchanged; same strong ETag or Last-Modified on 200 = unchanged', () => {
    expect(unchangedFrom(304, new Headers(), previous).unchanged).toBe(true);
    expect(unchangedFrom(200, new Headers({ etag: '"v1"' }), previous).unchanged).toBe(true);
    expect(
      unchangedFrom(200, new Headers({ 'last-modified': previous.lastModified }), previous)
        .unchanged,
    ).toBe(true);
  });

  it('changed validators, weak ETags and no previous validators = changed', () => {
    expect(unchangedFrom(200, new Headers({ etag: '"v2"' }), previous).unchanged).toBe(false);
    expect(
      unchangedFrom(200, new Headers({ etag: 'W/"v1"' }), { etag: 'W/"v1"', lastModified: null })
        .unchanged,
    ).toBe(false);
    expect(unchangedFrom(304, new Headers(), { etag: null, lastModified: null }).unchanged).toBe(
      false,
    );
  });

  it('PoliteFetcher.checkUnchanged sends If-None-Match / If-Modified-Since through the guard', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      new Response('', { status: 404 }),
      new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );
    const fetcher = new PoliteFetcher({
      fetchImpl,
      sleep: vi.fn(async () => undefined),
      now: () => 0,
      random: () => 0,
    });
    const check = await fetcher.checkUnchanged('https://bakery.example/', previous);
    expect(check?.unchanged).toBe(true);
    expect(requests[1]?.headers['if-none-match']).toBe('"v1"');
    expect(requests[1]?.headers['if-modified-since']).toBe(previous.lastModified);
    expect(requests[1]?.headers['user-agent']).toContain('PostMindStudio');
  });

  it('returns null when robots.txt disallows the page', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      new Response('User-agent: *\nDisallow: /', { status: 200 }),
    );
    const fetcher = new PoliteFetcher({ fetchImpl, sleep: async () => undefined, now: () => 0 });
    expect(await fetcher.checkUnchanged('https://bakery.example/', previous)).toBeNull();
  });
});
