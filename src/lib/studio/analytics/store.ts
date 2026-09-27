import type { Prisma, PrismaClient } from '@prisma/client';
import { bucketStart } from './schedule';

// BACKLOG 11.1 / 11.2 — analytics storage. Platforms report lifetime totals, so every
// video_analytics row is a CUMULATIVE snapshot: the latest totals seen within its bucket.
// Per-period activity is the difference between consecutive snapshots (see services/analytics).
// Retention (spec 17.4): hourly buckets 30 days (rolled up to daily), daily buckets 24 months.

export interface MetricSnapshot {
  views: number;
  uniqueViewers?: number | null;
  watchTimeSec?: number;
  avgWatchTimePct?: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves?: number;
  clicks?: number;
  retentionCurve?: Array<{ sec: number; retention: number }> | null;
  demographics?: Record<string, unknown> | null;
}

const HOURLY_RETENTION_DAYS = 30;
const DAILY_RETENTION_DAYS = 730;

function columns(m: MetricSnapshot) {
  const int = (v: number | undefined) => Math.max(0, Math.round(v ?? 0));
  return {
    views: int(m.views),
    uniqueViewers: m.uniqueViewers ?? null,
    watchTimeSec: int(m.watchTimeSec),
    avgWatchTimePct: m.avgWatchTimePct ?? null,
    likes: int(m.likes),
    comments: int(m.comments),
    shares: int(m.shares),
    saves: int(m.saves),
    clicks: int(m.clicks),
    ...(m.retentionCurve && { retentionCurve: m.retentionCurve as Prisma.InputJsonValue }),
    ...(m.demographics && { demographics: m.demographics as Prisma.InputJsonValue }),
  };
}

/** Record the latest totals in the current hour bucket (and the day bucket, for fresh charts). */
export async function recordSnapshot(
  db: Pick<PrismaClient, 'videoAnalytic'>,
  publicationId: string,
  metrics: MetricSnapshot,
  at: Date,
): Promise<void> {
  const data = columns(metrics);
  for (const bucketSize of ['hour', 'day'] as const) {
    const bucketAt = bucketStart(at, bucketSize);
    await db.videoAnalytic.upsert({
      where: { publicationId_bucketAt_bucketSize: { publicationId, bucketAt, bucketSize } },
      create: { publicationId, bucketAt, bucketSize, ...data },
      update: data,
    });
  }
}

/**
 * Nightly roll-up (queue studio-analytics, job roll-up-daily): make sure every day that has
 * hourly snapshots has a day bucket holding that day's last snapshot, then apply retention.
 */
export async function rollUpAnalytics(
  db: PrismaClient,
  now: number,
): Promise<{ dailyUpserted: number; hourlyDeleted: number; dailyDeleted: number }> {
  const since = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const latest = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT ON ("publicationId", date_trunc('day', "bucketAt")) id
    FROM studio.video_analytics
    WHERE "bucketSize" = 'hour' AND "bucketAt" >= ${since}
    ORDER BY "publicationId", date_trunc('day', "bucketAt"), "bucketAt" DESC`;
  const rows = await db.videoAnalytic.findMany({ where: { id: { in: latest.map((l) => l.id) } } });
  for (const row of rows) {
    const bucketAt = bucketStart(row.bucketAt, 'day');
    const { id: _id, bucketAt: _b, bucketSize: _s, publicationId, ...metrics } = row;
    void _id;
    void _b;
    void _s;
    const data = {
      ...metrics,
      retentionCurve: (metrics.retentionCurve ?? undefined) as Prisma.InputJsonValue | undefined,
      demographics: (metrics.demographics ?? undefined) as Prisma.InputJsonValue | undefined,
    };
    await db.videoAnalytic.upsert({
      where: { publicationId_bucketAt_bucketSize: { publicationId, bucketAt, bucketSize: 'day' } },
      create: { publicationId, bucketAt, bucketSize: 'day', ...data },
      update: data,
    });
  }
  const hourly = await db.videoAnalytic.deleteMany({
    where: {
      bucketSize: 'hour',
      bucketAt: { lt: new Date(now - HOURLY_RETENTION_DAYS * 86_400_000) },
    },
  });
  const daily = await db.videoAnalytic.deleteMany({
    where: {
      bucketSize: 'day',
      bucketAt: { lt: new Date(now - DAILY_RETENTION_DAYS * 86_400_000) },
    },
  });
  return { dailyUpserted: rows.length, hourlyDeleted: hourly.count, dailyDeleted: daily.count };
}

/** provider_usage (DERIVED): per org/provider/day counts and cost from provider_jobs. */
export async function rollUpProviderUsage(db: PrismaClient, day: Date): Promise<number> {
  const start = bucketStart(day, 'day');
  const end = new Date(start.getTime() + 86_400_000);
  const groups = await db.providerJob.groupBy({
    by: ['organisationId', 'provider', 'state'],
    where: { startedAt: { gte: start, lt: end } },
    _count: { _all: true },
    _sum: { costPence: true },
  });
  const merged = new Map<
    string,
    {
      organisationId: string;
      provider: string;
      jobs: number;
      ok: number;
      failed: number;
      cost: number;
    }
  >();
  for (const g of groups) {
    const key = `${g.organisationId}\u0000${g.provider}`;
    const m = merged.get(key) ?? {
      organisationId: g.organisationId,
      provider: g.provider,
      jobs: 0,
      ok: 0,
      failed: 0,
      cost: 0,
    };
    m.jobs += g._count._all;
    if (g.state === 'SUCCEEDED') m.ok += g._count._all;
    if (g.state === 'FAILED' || g.state === 'TIMED_OUT') m.failed += g._count._all;
    m.cost += g._sum.costPence ?? 0;
    merged.set(key, m);
  }
  for (const m of merged.values()) {
    const data = {
      jobCount: m.jobs,
      succeededCount: m.ok,
      failedCount: m.failed,
      costPence: m.cost,
    };
    await db.providerUsage.upsert({
      where: {
        organisationId_provider_day: {
          organisationId: m.organisationId,
          provider: m.provider,
          day: start,
        },
      },
      create: { organisationId: m.organisationId, provider: m.provider, day: start, ...data },
      update: data,
    });
  }
  return merged.size;
}
