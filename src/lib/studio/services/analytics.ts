import type { PrismaClient, VideoAnalytic } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError } from '../../errors';
import { bucketStart } from '../analytics/schedule';

// BACKLOG 11.3 / spec 8.7 — analytics endpoints. Snapshots are cumulative (analytics/store.ts):
// totals come from each publication's latest snapshot; per-day activity is the difference
// between a publication's consecutive daily snapshots. Everything is organisation-scoped.

type Db = PrismaClient;
const DAY_MS = 86_400_000;

export const windowQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => [7, 30, 90].includes(d), { message: 'days must be 7, 30 or 90' })
    .default(30),
});

export const METRICS = ['views', 'watchTime', 'engagement', 'likes', 'comments', 'shares'] as const;
export type Metric = (typeof METRICS)[number];

export const timeseriesQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  metric: z.enum(METRICS).default('views'),
});

export const leaderboardQuery = windowQuery.extend({
  metric: z.enum(METRICS).default('views'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

type Counts = Pick<
  VideoAnalytic,
  'views' | 'watchTimeSec' | 'likes' | 'comments' | 'shares' | 'saves'
>;

export function metricValue(row: Counts, metric: Metric): number {
  switch (metric) {
    case 'views':
      return row.views;
    case 'watchTime':
      return row.watchTimeSec;
    case 'engagement':
      return row.likes + row.comments + row.shares + row.saves;
    case 'likes':
      return row.likes;
    case 'comments':
      return row.comments;
    case 'shares':
      return row.shares;
  }
}

/** Latest snapshot per publication (any bucket size). */
async function latestSnapshots(db: Db, publicationIds: string[]) {
  if (publicationIds.length === 0) return new Map<string, VideoAnalytic>();
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT ON ("publicationId") id FROM studio.video_analytics
    WHERE "publicationId" = ANY(${publicationIds})
    ORDER BY "publicationId", "bucketAt" DESC, "bucketSize" ASC`;
  const full = await db.videoAnalytic.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return new Map(full.map((r) => [r.publicationId, r]));
}

async function publishedIn(db: Db, organisationId: string, since: Date) {
  return db.videoPublication.findMany({
    where: {
      organisationId,
      state: { in: ['PUBLISHED', 'TAKEN_DOWN'] },
      publishedAt: { gte: since },
    },
    select: {
      id: true,
      platform: true,
      platformUrl: true,
      publishedAt: true,
      projectId: true,
      caption: true,
    },
  });
}

export async function analyticsOverview(db: Db, organisationId: string, days: number, now: number) {
  const since = new Date(now - days * DAY_MS);
  const pubs = await publishedIn(db, organisationId, since);
  const latest = await latestSnapshots(
    db,
    pubs.map((p) => p.id),
  );
  const totals = { views: 0, watchTimeSec: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
  const byPlatform: Record<string, { publications: number; views: number; engagement: number }> =
    {};
  for (const pub of pubs) {
    const s = latest.get(pub.id);
    const platform = (byPlatform[pub.platform] ??= { publications: 0, views: 0, engagement: 0 });
    platform.publications += 1;
    if (!s) continue;
    totals.views += s.views;
    totals.watchTimeSec += s.watchTimeSec;
    totals.likes += s.likes;
    totals.comments += s.comments;
    totals.shares += s.shares;
    totals.saves += s.saves;
    platform.views += s.views;
    platform.engagement += metricValue(s, 'engagement');
  }
  const projects = await db.videoProject.count({
    where: { organisationId, deletedAt: null, createdAt: { gte: since } },
  });
  return { days, publications: pubs.length, projectsCreated: projects, totals, byPlatform };
}

export async function publicationAnalytics(db: Db, organisationId: string, id: string) {
  const publication = await db.videoPublication.findFirst({
    where: { id, organisationId },
    select: { id: true, platform: true, platformUrl: true, publishedAt: true, state: true },
  });
  if (!publication) throw new NotFoundError('Publication not found');
  const rows = await db.videoAnalytic.findMany({
    where: { publicationId: id },
    orderBy: { bucketAt: 'asc' },
  });
  const hourly = rows.filter((r) => r.bucketSize === 'hour');
  const daily = rows.filter((r) => r.bucketSize === 'day');
  const latest = [...rows].sort((a, b) => b.bucketAt.getTime() - a.bucketAt.getTime())[0] ?? null;
  const point = (r: VideoAnalytic) => ({
    at: r.bucketAt.toISOString(),
    views: r.views,
    watchTimeSec: r.watchTimeSec,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
  });
  return {
    publication,
    latest: latest && {
      ...point(latest),
      uniqueViewers: latest.uniqueViewers,
      avgWatchTimePct: latest.avgWatchTimePct,
      clicks: latest.clicks,
      retentionCurve: latest.retentionCurve,
      demographics: latest.demographics,
    },
    hourly: hourly.map(point),
    daily: daily.map(point),
  };
}

/** Daily activity across the org: sum over publications of (today's total − previous total). */
export async function analyticsTimeseries(
  db: Db,
  organisationId: string,
  query: z.infer<typeof timeseriesQuery>,
  now: number,
) {
  const start = bucketStart(new Date(now - (query.days - 1) * DAY_MS), 'day');
  const rows = await db.videoAnalytic.findMany({
    where: {
      bucketSize: 'day',
      bucketAt: { gte: new Date(start.getTime() - DAY_MS) },
      publication: { organisationId },
    },
    orderBy: [{ publicationId: 'asc' }, { bucketAt: 'asc' }],
  });
  const perDay = new Map<string, number>();
  for (let t = start.getTime(); t <= now; t += DAY_MS)
    perDay.set(new Date(t).toISOString().slice(0, 10), 0);
  let previous: VideoAnalytic | undefined;
  for (const row of rows) {
    const base =
      previous?.publicationId === row.publicationId ? metricValue(previous, query.metric) : 0;
    const key = row.bucketAt.toISOString().slice(0, 10);
    if (perDay.has(key))
      perDay.set(key, (perDay.get(key) ?? 0) + Math.max(0, metricValue(row, query.metric) - base));
    previous = row;
  }
  return {
    metric: query.metric,
    data: [...perDay.entries()].map(([day, value]) => ({ day, value })),
  };
}

export async function analyticsLeaderboard(
  db: Db,
  organisationId: string,
  query: z.infer<typeof leaderboardQuery>,
  now: number,
) {
  const pubs = await publishedIn(db, organisationId, new Date(now - query.days * DAY_MS));
  const latest = await latestSnapshots(
    db,
    pubs.map((p) => p.id),
  );
  return {
    metric: query.metric,
    data: pubs
      .map((p) => {
        const s = latest.get(p.id);
        return { ...p, value: s ? metricValue(s, query.metric) : 0 };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, query.limit),
  };
}

/** BACKLOG 11.4 — cost by provider, by project and by day from the provider-job ledger. */
export async function analyticsCost(db: Db, organisationId: string, days: number, now: number) {
  const since = new Date(now - days * DAY_MS);
  const where = { organisationId, startedAt: { gte: since } };
  const [byProvider, byProject, byDay] = await Promise.all([
    db.providerJob.groupBy({
      by: ['provider'],
      where,
      _sum: { costPence: true },
      _count: { _all: true },
    }),
    db.providerJob.groupBy({ by: ['projectId'], where, _sum: { costPence: true } }),
    db.$queryRaw<Array<{ day: Date; costPence: bigint }>>`
      SELECT date_trunc('day', "startedAt") AS day, COALESCE(SUM("costPence"), 0) AS "costPence"
      FROM studio.provider_jobs
      WHERE "organisationId" = ${organisationId} AND "startedAt" >= ${since}
      GROUP BY 1 ORDER BY 1`,
  ]);
  const total = byProvider.reduce((t, p) => t + (p._sum.costPence ?? 0), 0);
  return {
    days,
    totalPence: total,
    byProvider: byProvider
      .map((p) => ({ provider: p.provider, costPence: p._sum.costPence ?? 0, jobs: p._count._all }))
      .sort((a, b) => b.costPence - a.costPence),
    byProject: byProject
      .map((p) => ({ projectId: p.projectId, costPence: p._sum.costPence ?? 0 }))
      .sort((a, b) => b.costPence - a.costPence)
      .slice(0, 50),
    byDay: byDay.map((d) => ({
      day: d.day.toISOString().slice(0, 10),
      costPence: Number(d.costPence),
    })),
  };
}

export const adminCostQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  organisationId: z.string().max(128).optional(),
});

/** Admin Centre cost dashboard (spec 16.4): per org, per provider, per day from provider_usage. */
export async function adminCostDashboard(
  db: Db,
  query: z.infer<typeof adminCostQuery>,
  now: number,
) {
  const rows = await db.providerUsage.findMany({
    where: {
      day: { gte: bucketStart(new Date(now - query.days * DAY_MS), 'day') },
      ...(query.organisationId && { organisationId: query.organisationId }),
    },
    orderBy: [{ day: 'asc' }, { organisationId: 'asc' }, { provider: 'asc' }],
    take: 5_000,
  });
  return {
    days: query.days,
    data: rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      organisationId: r.organisationId,
      provider: r.provider,
      jobs: r.jobCount,
      succeeded: r.succeededCount,
      failed: r.failedCount,
      costPence: r.costPence,
    })),
  };
}
