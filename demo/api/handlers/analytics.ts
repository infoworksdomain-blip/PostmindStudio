// /analytics/* (agent "insight"): overview, daily timeseries, leaderboard and provider cost for
// Leeds Sourdough. Engagement comes from analytics-model.ts over the shared publications store;
// cost from the provider-job ledger in analytics-cost-data.ts.
import { DEMO_ORG_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { dayKey, ledger, rollup } from './analytics-cost-data';
import {
  countsAt,
  livePosts,
  METRICS,
  metricValue,
  type Counts,
  type Metric,
} from './analytics-model';
import { allProjects } from './projects-store';

const DAY = 86_400_000;

function windowDays(query: URLSearchParams): number {
  const days = Number(query.get('days') ?? 30);
  if (![7, 30, 90].includes(days))
    throw new DemoHttpError(400, 'validation_error', 'days must be 7, 30 or 90');
  return days;
}

function metricParam(query: URLSearchParams): Metric {
  const m = (query.get('metric') ?? 'views') as Metric;
  if (!METRICS.includes(m)) throw new DemoHttpError(400, 'validation_error', 'Unknown metric');
  return m;
}

/** 25.11: optional ?businessId= narrows to that business's projects (as the service does). */
function businessPosts(query: URLSearchParams) {
  const businessId = query.get('businessId')?.trim() || null;
  if (!businessId) return livePosts();
  const projects = new Set(
    allProjects()
      .filter((p) => p.businessId === businessId)
      .map((p) => p.id),
  );
  return livePosts().filter((p) => projects.has(p.pub.projectId));
}

const publishedSince = (days: number, query: URLSearchParams) => {
  const since = Date.now() - days * DAY;
  return businessPosts(query).filter((p) => p.publishedMs >= since);
};

route('GET', '/analytics/overview', ({ query }) => {
  const days = windowDays(query);
  const now = Date.now();
  const posts = publishedSince(days, query);
  const totals: Counts = { views: 0, watchTimeSec: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
  const byPlatform: Record<string, { publications: number; views: number; engagement: number }> =
    {};
  for (const post of posts) {
    const c = countsAt(post, now);
    totals.views += c.views;
    totals.watchTimeSec += c.watchTimeSec;
    totals.likes += c.likes;
    totals.comments += c.comments;
    totals.shares += c.shares;
    totals.saves += c.saves;
    const row = byPlatform[post.pub.platform] ?? { publications: 0, views: 0, engagement: 0 };
    byPlatform[post.pub.platform] = {
      publications: row.publications + 1,
      views: row.views + c.views,
      engagement: row.engagement + metricValue(c, 'engagement'),
    };
  }
  const since = new Date(now - days * DAY).toISOString();
  const businessId = query.get('businessId')?.trim() || null;
  return {
    days,
    businessId,
    publications: posts.length,
    projectsCreated: allProjects().filter(
      (p) => p.createdAt >= since && (!businessId || p.businessId === businessId),
    ).length,
    totals,
    byPlatform,
  };
});

route('GET', '/analytics/timeseries', ({ query }) => {
  const days = Math.min(365, Math.max(1, Number(query.get('days') ?? 30) || 30));
  const metric = metricParam(query);
  const now = Date.now();
  const posts = businessPosts(query);
  const todayStart = Date.parse(`${dayKey(0)}T00:00:00.000Z`);
  const data = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = todayStart - i * DAY;
    const end = Math.min(now, start + DAY);
    let value = 0;
    for (const post of posts) {
      if (post.publishedMs >= end) continue;
      value +=
        metricValue(countsAt(post, end), metric) - metricValue(countsAt(post, start), metric);
    }
    data.push({
      day: new Date(start).toISOString().slice(0, 10),
      value: Math.max(0, Math.round(value)),
    });
  }
  return { metric, data };
});

route('GET', '/analytics/leaderboard', ({ query }) => {
  const days = windowDays(query);
  const metric = metricParam(query);
  const limit = Math.min(50, Math.max(1, Number(query.get('limit') ?? 10) || 10));
  const now = Date.now();
  const data = publishedSince(days, query)
    .map((post) => ({
      id: post.pub.id,
      renderId: post.pub.renderId,
      platform: post.pub.platform,
      platformUrl: post.pub.platformUrl,
      publishedAt: post.pub.publishedAt,
      projectId: post.pub.projectId,
      caption: post.pub.caption,
      value: metricValue(countsAt(post, now), metric),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
  return { metric, data };
});

route('GET', '/analytics/cost', ({ query }) => {
  const days = windowDays(query);
  const from = dayKey(days - 1);
  const rows = ledger().filter((r) => r.organisationId === DEMO_ORG_ID && r.day >= from);
  return {
    days,
    totalPence: rows.reduce((t, r) => t + r.costPence, 0),
    byProvider: rollup(rows, (r) => r.provider).map((p) => ({
      provider: p.key,
      costPence: p.costPence,
      jobs: p.jobs,
    })),
    byProject: rollup(rows, (r) => r.projectId).map((p) => ({
      projectId: p.key,
      costPence: p.costPence,
    })),
    byDay: rollup(rows, (r) => r.day)
      .map((d) => ({ day: d.key, costPence: d.costPence }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
});
