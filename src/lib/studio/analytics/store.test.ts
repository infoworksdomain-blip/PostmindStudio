import type { PrismaClient, VideoAnalytic } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { bucketStart } from './schedule';
import { recordSnapshot, rollUpAnalytics, rollUpProviderUsage } from './store';
import type { MetricSnapshot } from './store';

// ---------------------------------------------------------------- recordSnapshot

function fakeAnalyticDb() {
  const upsert = vi.fn().mockResolvedValue({});
  const db = { videoAnalytic: { upsert } } as unknown as Pick<PrismaClient, 'videoAnalytic'>;
  return { db, videoAnalytic: { upsert } };
}

describe('recordSnapshot', () => {
  it('upserts both an hour and a day bucket', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const at = new Date('2026-03-15T13:47:00Z');
    const metrics: MetricSnapshot = { views: 10, likes: 2, comments: 1, shares: 0 };

    await recordSnapshot(db, 'pub-1', metrics, at);

    expect(videoAnalytic.upsert).toHaveBeenCalledTimes(2);
    const [hourCall, dayCall] = videoAnalytic.upsert.mock.calls;
    expect(hourCall?.[0]).toMatchObject({
      where: {
        publicationId_bucketAt_bucketSize: {
          publicationId: 'pub-1',
          bucketAt: bucketStart(at, 'hour'),
          bucketSize: 'hour',
        },
      },
    });
    expect(dayCall?.[0]).toMatchObject({
      where: {
        publicationId_bucketAt_bucketSize: {
          publicationId: 'pub-1',
          bucketAt: bucketStart(at, 'day'),
          bucketSize: 'day',
        },
      },
    });
  });

  it('rounds fractional counters to the nearest integer', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = {
      views: 10.4,
      watchTimeSec: 99.6,
      likes: 2.5,
      comments: 1,
      shares: 0,
      saves: 3.2,
      clicks: 4.8,
    };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    expect(videoAnalytic.upsert.mock.calls[0]?.[0].create).toMatchObject({
      views: 10,
      watchTimeSec: 100,
      likes: 3,
      comments: 1,
      shares: 0,
      saves: 3,
      clicks: 5,
    });
  });

  it('clamps negative counters to zero', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = { views: -5, likes: -1, comments: 0, shares: -3 };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    expect(videoAnalytic.upsert.mock.calls[0]?.[0].create).toMatchObject({
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    });
  });

  it('defaults missing optional counters (watchTimeSec, saves, clicks) to zero', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = { views: 1, likes: 0, comments: 0, shares: 0 };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    expect(videoAnalytic.upsert.mock.calls[0]?.[0].create).toMatchObject({
      watchTimeSec: 0,
      saves: 0,
      clicks: 0,
    });
  });

  it('carries uniqueViewers and avgWatchTimePct through as-is, defaulting to null', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = { views: 1, likes: 0, comments: 0, shares: 0 };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    expect(videoAnalytic.upsert.mock.calls[0]?.[0].create).toMatchObject({
      uniqueViewers: null,
      avgWatchTimePct: null,
    });
  });

  it('only includes retentionCurve and demographics when present', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = { views: 1, likes: 0, comments: 0, shares: 0 };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    const create = videoAnalytic.upsert.mock.calls[0]?.[0].create;
    expect(create).not.toHaveProperty('retentionCurve');
    expect(create).not.toHaveProperty('demographics');
  });

  it('includes retentionCurve and demographics as JSON when provided', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = {
      views: 1,
      likes: 0,
      comments: 0,
      shares: 0,
      retentionCurve: [{ sec: 1, retention: 0.9 }],
      demographics: { age: { '18-24': 0.5 } },
    };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    const create = videoAnalytic.upsert.mock.calls[0]?.[0].create;
    expect(create).toMatchObject({
      retentionCurve: [{ sec: 1, retention: 0.9 }],
      demographics: { age: { '18-24': 0.5 } },
    });
  });

  it('update payload is the create payload minus the bucket identity fields', async () => {
    const { db, videoAnalytic } = fakeAnalyticDb();
    const metrics: MetricSnapshot = { views: 1, likes: 2, comments: 3, shares: 4 };

    await recordSnapshot(db, 'pub-1', metrics, new Date('2026-03-15T13:47:00Z'));

    const [call] = videoAnalytic.upsert.mock.calls;
    const { publicationId: _p, bucketAt: _b, bucketSize: _s, ...expectedUpdate } = call?.[0].create;
    void _p;
    void _b;
    void _s;
    expect(call?.[0].update).toEqual(expectedUpdate);
  });
});

// ---------------------------------------------------------------- rollUpAnalytics

function fakeRollupDb(rows: VideoAnalytic[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows.map((r) => ({ id: r.id }))),
    videoAnalytic: {
      findMany: vi.fn().mockResolvedValue(rows),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 7 }),
    },
  };
}

function hourlyRow(overrides: Partial<VideoAnalytic> = {}): VideoAnalytic {
  return {
    id: 'row-1',
    publicationId: 'pub-1',
    bucketAt: new Date('2026-03-15T13:00:00Z'),
    bucketSize: 'hour',
    views: 10,
    uniqueViewers: 5,
    watchTimeSec: 100,
    avgWatchTimePct: 0.5,
    likes: 1,
    comments: 2,
    shares: 3,
    saves: 4,
    clicks: 6,
    retentionCurve: null,
    demographics: null,
    ...overrides,
  };
}

describe('rollUpAnalytics', () => {
  it('copies each row (the latest hourly snapshot per publication/day) into a day bucket', async () => {
    const row = hourlyRow();
    const db = fakeRollupDb([row]);
    const now = Date.parse('2026-03-20T00:00:00Z');

    const result = await rollUpAnalytics(db as unknown as PrismaClient, now);

    expect(db.videoAnalytic.upsert).toHaveBeenCalledTimes(1);
    const call = db.videoAnalytic.upsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({
      publicationId_bucketAt_bucketSize: {
        publicationId: 'pub-1',
        bucketAt: bucketStart(row.bucketAt, 'day'),
        bucketSize: 'day',
      },
    });
    expect(call.create).toMatchObject({
      publicationId: 'pub-1',
      bucketAt: bucketStart(row.bucketAt, 'day'),
      bucketSize: 'day',
      views: 10,
      likes: 1,
      comments: 2,
      shares: 3,
      saves: 4,
      clicks: 6,
    });
    const { publicationId: _p, bucketAt: _b, bucketSize: _s, ...expectedUpdate } = call.create;
    void _p;
    void _b;
    void _s;
    expect(call.update).toEqual(expectedUpdate);
    expect(result.dailyUpserted).toBe(1);
  });

  it('processes one day bucket per row returned by findMany', async () => {
    const rows = [
      hourlyRow({ id: 'a', publicationId: 'pub-1' }),
      hourlyRow({ id: 'b', publicationId: 'pub-2', bucketAt: new Date('2026-03-16T09:00:00Z') }),
    ];
    const db = fakeRollupDb(rows);

    const result = await rollUpAnalytics(
      db as unknown as PrismaClient,
      Date.parse('2026-03-20T00:00:00Z'),
    );

    expect(db.videoAnalytic.upsert).toHaveBeenCalledTimes(2);
    expect(result.dailyUpserted).toBe(2);
  });

  it('maps null retentionCurve/demographics to undefined rather than null', async () => {
    const db = fakeRollupDb([hourlyRow({ retentionCurve: null, demographics: null })]);

    await rollUpAnalytics(db as unknown as PrismaClient, Date.parse('2026-03-20T00:00:00Z'));

    const create = db.videoAnalytic.upsert.mock.calls[0]?.[0].create;
    expect(create.retentionCurve).toBeUndefined();
    expect(create.demographics).toBeUndefined();
  });

  it('preserves non-null retentionCurve/demographics JSON', async () => {
    const curve = [{ sec: 1, retention: 0.8 }];
    const demo = { age: { '25-34': 0.6 } };
    const db = fakeRollupDb([hourlyRow({ retentionCurve: curve, demographics: demo })]);

    await rollUpAnalytics(db as unknown as PrismaClient, Date.parse('2026-03-20T00:00:00Z'));

    const create = db.videoAnalytic.upsert.mock.calls[0]?.[0].create;
    expect(create.retentionCurve).toEqual(curve);
    expect(create.demographics).toEqual(demo);
  });

  it('deletes hourly buckets older than 30 days and daily buckets older than 730 days', async () => {
    const db = fakeRollupDb([]);
    const now = Date.parse('2026-03-20T00:00:00Z');

    const result = await rollUpAnalytics(db as unknown as PrismaClient, now);

    expect(db.videoAnalytic.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { bucketSize: 'hour', bucketAt: { lt: new Date(now - 30 * 86_400_000) } },
    });
    expect(db.videoAnalytic.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { bucketSize: 'day', bucketAt: { lt: new Date(now - 730 * 86_400_000) } },
    });
    expect(result).toEqual({ dailyUpserted: 0, hourlyDeleted: 3, dailyDeleted: 7 });
  });

  it('returns zero upserts when there are no recent hourly snapshots', async () => {
    const db = fakeRollupDb([]);

    const result = await rollUpAnalytics(
      db as unknown as PrismaClient,
      Date.parse('2026-03-20T00:00:00Z'),
    );

    expect(db.videoAnalytic.upsert).not.toHaveBeenCalled();
    expect(result.dailyUpserted).toBe(0);
  });
});

// ---------------------------------------------------------------- rollUpProviderUsage

interface GroupByRow {
  organisationId: string;
  provider: string;
  state: string;
  _count: { _all: number };
  _sum: { costPence: number | null };
}

function fakeProviderUsageDb(groups: GroupByRow[]) {
  return {
    providerJob: { groupBy: vi.fn().mockResolvedValue(groups) },
    providerUsage: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe('rollUpProviderUsage', () => {
  it('merges multiple states for the same org/provider into one row', async () => {
    const db = fakeProviderUsageDb([
      {
        organisationId: 'org-1',
        provider: 'runway',
        state: 'SUCCEEDED',
        _count: { _all: 5 },
        _sum: { costPence: 500 },
      },
      {
        organisationId: 'org-1',
        provider: 'runway',
        state: 'FAILED',
        _count: { _all: 2 },
        _sum: { costPence: 0 },
      },
    ]);
    const day = new Date('2026-03-15T00:00:00Z');

    const count = await rollUpProviderUsage(db as unknown as PrismaClient, day);

    expect(count).toBe(1);
    expect(db.providerUsage.upsert).toHaveBeenCalledTimes(1);
    const call = db.providerUsage.upsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({
      organisationId_provider_day: {
        organisationId: 'org-1',
        provider: 'runway',
        day: bucketStart(day, 'day'),
      },
    });
    expect(call.create).toMatchObject({
      organisationId: 'org-1',
      provider: 'runway',
      day: bucketStart(day, 'day'),
      jobCount: 7,
      succeededCount: 5,
      failedCount: 2,
      costPence: 500,
    });
    expect(call.update).toEqual({
      jobCount: 7,
      succeededCount: 5,
      failedCount: 2,
      costPence: 500,
    });
  });

  it('counts both FAILED and TIMED_OUT states as failed', async () => {
    const db = fakeProviderUsageDb([
      {
        organisationId: 'org-1',
        provider: 'elevenlabs',
        state: 'FAILED',
        _count: { _all: 1 },
        _sum: { costPence: 10 },
      },
      {
        organisationId: 'org-1',
        provider: 'elevenlabs',
        state: 'TIMED_OUT',
        _count: { _all: 1 },
        _sum: { costPence: 0 },
      },
    ]);

    await rollUpProviderUsage(db as unknown as PrismaClient, new Date('2026-03-15T00:00:00Z'));

    const call = db.providerUsage.upsert.mock.calls[0]?.[0];
    expect(call.create.failedCount).toBe(2);
    expect(call.create.succeededCount).toBe(0);
  });

  it('keeps separate org/provider combinations as separate rows', async () => {
    const db = fakeProviderUsageDb([
      {
        organisationId: 'org-1',
        provider: 'runway',
        state: 'SUCCEEDED',
        _count: { _all: 1 },
        _sum: { costPence: 100 },
      },
      {
        organisationId: 'org-2',
        provider: 'runway',
        state: 'SUCCEEDED',
        _count: { _all: 1 },
        _sum: { costPence: 200 },
      },
      {
        organisationId: 'org-1',
        provider: 'luma',
        state: 'SUCCEEDED',
        _count: { _all: 1 },
        _sum: { costPence: 300 },
      },
    ]);

    const count = await rollUpProviderUsage(
      db as unknown as PrismaClient,
      new Date('2026-03-15T00:00:00Z'),
    );

    expect(count).toBe(3);
    expect(db.providerUsage.upsert).toHaveBeenCalledTimes(3);
  });

  it('defaults a missing cost sum to zero', async () => {
    const db = fakeProviderUsageDb([
      {
        organisationId: 'org-1',
        provider: 'runway',
        state: 'SUCCEEDED',
        _count: { _all: 1 },
        _sum: { costPence: null },
      },
    ]);

    await rollUpProviderUsage(db as unknown as PrismaClient, new Date('2026-03-15T00:00:00Z'));

    expect(db.providerUsage.upsert.mock.calls[0]?.[0].create.costPence).toBe(0);
  });

  it('returns zero and issues no upserts when there are no jobs for the day', async () => {
    const db = fakeProviderUsageDb([]);

    const count = await rollUpProviderUsage(
      db as unknown as PrismaClient,
      new Date('2026-03-15T00:00:00Z'),
    );

    expect(count).toBe(0);
    expect(db.providerUsage.upsert).not.toHaveBeenCalled();
  });
});
