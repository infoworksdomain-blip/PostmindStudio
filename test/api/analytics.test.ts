import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as adminCostRoute from '../../src/app/api/studio/admin/cost/route';
import * as costRoute from '../../src/app/api/studio/analytics/cost/route';
import * as leaderboardRoute from '../../src/app/api/studio/analytics/leaderboard/route';
import * as overviewRoute from '../../src/app/api/studio/analytics/overview/route';
import * as publicationRoute from '../../src/app/api/studio/analytics/publications/[id]/route';
import * as timeseriesRoute from '../../src/app/api/studio/analytics/timeseries/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { MetricsFetcher } from '../../src/lib/studio/analytics/fetchers';
import type { MetricSnapshot } from '../../src/lib/studio/analytics/store';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { withHashtags } from '../helpers/hashtags';

// BACKLOG 11.1–11.4: publish → analytics polling (spec 15.2 schedule) → cumulative snapshots →
// overview / per-publication / timeseries / leaderboard / cost, and the nightly roll-ups.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('analytics polling + endpoints', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-analytics-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    other: tenant(`api-analytics-other-${randomUUID()}`),
    admin: tenant(org, ['studio:admin:providers']),
  };
  let clock = Date.parse('2026-09-01T10:00:00Z');
  const snapshots: MetricSnapshot[] = [];
  const fetcher: MetricsFetcher = {
    platform: 'tiktok',
    fetch: async () => ({
      snapshot: snapshots.shift() ?? { views: 0, likes: 0, comments: 0, shares: 0 },
    }),
  };
  let h: ReturnType<typeof createHarness>;
  const publicationIds: string[] = [];

  beforeAll(async () => {
    h = createHarness(db, { metrics: { tiktok: fetcher } });
    h.deps.now = () => clock;
    h.deps.publishing.now = () => clock;
    h.queue.defer.add('poll-publication-analytics');
    const api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    api.deps.now = () => clock;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoAnalytic.deleteMany({ where: { publicationId: { in: publicationIds } } });
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function publishOne(caption: string) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: caption,
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata: { runId: randomUUID() },
      },
    });
    const key = `orgs/${org}/renders/${randomUUID()}.mp4`;
    await h.deps.storage.put({
      bucket: 'renders',
      key,
      body: new Uint8Array(64),
      contentType: 'video/mp4',
    });
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: 's',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: key,
        qualityCheckState: 'PASSED',
      },
    });
    const sealed = await sealTokens(h.keys, org, 'tiktok', {
      accessToken: 'tt-access',
      expiresAt: new Date(clock + 60 * DAY),
      scopes: ['video.publish', 'video.list'],
    });
    const connection = await db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        platform: 'tiktok',
        platformAccountId: `acct-${randomUUID()}`,
        platformAccountName: 'Bakery',
        ...sealed,
        scopes: ['video.publish', 'video.list'],
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });
    const res = await call(publicationsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: withHashtags({
        renderId: render.id,
        platform: 'tiktok',
        connectionId: connection.id,
        caption,
      }),
    });
    expect(res.status).toBe(202);
    await drainInline(h.queue, h.deps);
    const id = (res.json.publication as { id: string }).id;
    publicationIds.push(id);
    return id;
  }

  const poll = async (snapshot: MetricSnapshot) => {
    snapshots.push(snapshot);
    expect(h.queue.release('poll-publication-analytics')).toBeGreaterThanOrEqual(1);
    await drainInline(h.queue, h.deps);
  };

  it('polls on the spec 15.2 schedule and stores cumulative snapshots', async () => {
    const first = await publishOne('Dawn bake');
    const queued = h.queue.deferred.at(-1);
    expect(queued?.name).toBe('poll-publication-analytics');

    clock += 30_000;
    await poll({ views: 120, likes: 10, comments: 2, shares: 1 });
    // Next poll 30 s later (first five minutes).
    expect(h.queue.deferred).toHaveLength(1);

    clock += DAY;
    await poll({ views: 900, likes: 80, comments: 9, shares: 5, saves: 3, watchTimeSec: 1200 });
    const rows = await db.videoAnalytic.findMany({
      where: { publicationId: first },
      orderBy: { bucketAt: 'asc' },
    });
    expect(rows.filter((r) => r.bucketSize === 'day').map((r) => r.views)).toEqual([120, 900]);

    await publishOne('Sourdough tips');
    clock += 30_000;
    // Release both queued polls: first gets no new data (same totals), second gets 50 views.
    snapshots.push({ views: 900, likes: 80, comments: 9, shares: 5, saves: 3, watchTimeSec: 1200 });
    snapshots.push({ views: 50, likes: 5, comments: 0, shares: 0 });
    h.queue.release('poll-publication-analytics');
    await drainInline(h.queue, h.deps);
  });

  it('serves overview, publication detail, timeseries and leaderboard', async () => {
    const overview = await call(overviewRoute.GET, {
      token: 'reader',
      path: '/api/studio/analytics/overview?days=30',
    });
    expect(overview.json).toMatchObject({
      publications: 2,
      totals: { views: 950, likes: 85, comments: 9, shares: 5, saves: 3, watchTimeSec: 1200 },
      byPlatform: { tiktok: { publications: 2, views: 950 } },
    });
    expect(
      (
        await call(overviewRoute.GET, {
          token: 'reader',
          path: '/api/studio/analytics/overview?days=14',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(overviewRoute.GET, {
          token: 'other',
          path: '/api/studio/analytics/overview?days=30',
        })
      ).json,
    ).toMatchObject({ publications: 0 });

    const detail = await call(publicationRoute.GET, {
      token: 'reader',
      params: { id: publicationIds[0] ?? '' },
    });
    expect(detail.json.latest).toMatchObject({ views: 900, watchTimeSec: 1200 });
    expect((detail.json.daily as unknown[]).length).toBe(2);
    expect(
      (
        await call(publicationRoute.GET, {
          token: 'other',
          params: { id: publicationIds[0] ?? '' },
        })
      ).status,
    ).toBe(404);

    const series = await call(timeseriesRoute.GET, {
      token: 'reader',
      path: '/api/studio/analytics/timeseries?days=3&metric=views',
    });
    const values = (series.json.data as Array<{ day: string; value: number }>).map((d) => d.value);
    // day 1: 120 new views; day 2: +780 on the first video, +50 on the second
    expect(values.slice(-2)).toEqual([120, 830]);

    const board = await call(leaderboardRoute.GET, {
      token: 'reader',
      path: '/api/studio/analytics/leaderboard?days=30&metric=engagement&limit=5',
    });
    const top = board.json.data as Array<{ id: string; value: number }>;
    expect(top.map((t) => t.id)).toEqual(publicationIds);
    expect(top[0]?.value).toBe(80 + 9 + 5 + 3);
  });

  it('rolls up and reports cost', async () => {
    await db.providerJob.createMany({
      data: [
        {
          organisationId: org,
          provider: 'runway',
          operation: 'text_to_video',
          requestBody: {},
          state: 'SUCCEEDED',
          costPence: 45,
          startedAt: new Date(clock),
        },
        {
          organisationId: org,
          provider: 'runway',
          operation: 'text_to_video',
          requestBody: {},
          state: 'TIMED_OUT',
          costPence: 0,
          startedAt: new Date(clock),
        },
        {
          organisationId: org,
          provider: 'anthropic',
          operation: 'text_generation',
          requestBody: {},
          state: 'SUCCEEDED',
          costPence: 3,
          startedAt: new Date(clock),
        },
      ],
    });
    const cost = await call(costRoute.GET, {
      token: 'reader',
      path: '/api/studio/analytics/cost?days=7',
    });
    expect(cost.json).toMatchObject({
      totalPence: 48,
      byProvider: [
        { provider: 'runway', costPence: 45, jobs: 2 },
        { provider: 'anthropic', costPence: 3, jobs: 1 },
      ],
    });

    h.queue.add('roll-up-analytics', {
      organisationId: 'postmind-platform',
      runId: new Date(clock).toISOString().slice(0, 10),
      planTier: 'STANDARD',
    });
    await drainInline(h.queue, h.deps);
    const usage = await db.providerUsage.findMany({
      where: { organisationId: org },
      orderBy: { provider: 'asc' },
    });
    expect(
      usage.map((u) => [u.provider, u.jobCount, u.succeededCount, u.failedCount, u.costPence]),
    ).toEqual([
      ['anthropic', 1, 1, 0, 3],
      ['runway', 2, 1, 1, 45],
    ]);

    expect(
      (await call(adminCostRoute.GET, { token: 'reader', path: '/api/studio/admin/cost?days=30' }))
        .status,
    ).toBe(403);
    const admin = await call(adminCostRoute.GET, {
      token: 'admin',
      path: `/api/studio/admin/cost?days=60&organisationId=${org}`,
    });
    expect((admin.json.data as unknown[]).length).toBe(2);
  });

  it('stops polling when a post is taken down or has no metrics API', async () => {
    const id = publicationIds[1] ?? '';
    await db.videoPublication.update({ where: { id }, data: { state: 'TAKEN_DOWN' } });
    const before = await db.videoAnalytic.count({ where: { publicationId: id } });
    h.queue.release('poll-publication-analytics');
    await drainInline(h.queue, h.deps);
    expect(await db.videoAnalytic.count({ where: { publicationId: id } })).toBe(before);
    expect(
      h.queue.deferred.filter((j) => (j.data as { publicationId: string }).publicationId === id),
    ).toHaveLength(0);

    // A platform with no fetcher is marked unavailable instead of polled forever.
    const first = publicationIds[0] ?? '';
    h.deps.metrics = {};
    h.queue.release('poll-publication-analytics');
    await drainInline(h.queue, h.deps);
    const pub = await db.videoPublication.findUniqueOrThrow({ where: { id: first } });
    expect(pub.metadata).toMatchObject({ analytics: { unavailable: 'no metrics API for tiktok' } });
    expect(h.queue.deferred).toHaveLength(0);
  });
});
