import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as bestTimesRoute from '../../src/app/api/studio/analytics/best-times/route';
import * as dripRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/route';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as suggestRoute from '../../src/app/api/studio/projects/[id]/caption-suggestions/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import * as captionsRoute from '../../src/app/api/studio/renders/[id]/captions/route';
import * as renderRoute from '../../src/app/api/studio/renders/[id]/route';
import * as thumbnailRoute from '../../src/app/api/studio/renders/[id]/thumbnail/route';
import { PlatformError } from '../../src/lib/errors';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, multipart, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { withHashtags } from '../helpers/hashtags';

// Phase 15 Track A — publishing and distribution through the real routes, the real publish
// worker (inline queue) and Postgres: drip queue + SCHEDULED approval (A5), best times (A6),
// caption suggestions (A7), latest metrics (A8), thumbnails (A3), captions (A4), YouTube quota
// back-off (A9).

const hasDb = Boolean(process.env.DATABASE_URL);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const SUGGESTIONS = {
  suggestions: [
    { platform: 'tiktok', caption: 'Le vendredi, c’est sourdough', hashtags: ['pain', 'leeds'] },
    { platform: 'x', caption: 'Pain frais '.repeat(60), hashtags: ['a', 'b', 'c'] },
  ],
};

describe.skipIf(!hasDb)('Phase 15 Track A publishing API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p15a-${randomUUID()}`;
  const biz = `biz-${randomUUID().slice(0, 8)}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-p15a-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    h = createHarness(db, { safety: SUGGESTIONS });
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    api.deps.thumbnails = {
      bucket: 'thumbnails',
      composer: { compose: async () => JPEG },
    };
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    const pubs = await db.videoPublication.findMany({
      where: { projectId: { in: ids } },
      select: { id: true },
    });
    await db.videoAnalytic.deleteMany({ where: { publicationId: { in: pubs.map((p) => p.id) } } });
    await db.scheduledPublication.deleteMany({
      where: { publicationId: { in: pubs.map((p) => p.id) } },
    });
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.autoPublishOutbox.deleteMany({ where: { organisationId: org } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    const scripts = await db.videoScript.findMany({
      where: { projectId: { in: ids } },
      select: { id: true },
    });
    await db.videoShot.deleteMany({ where: { scriptId: { in: scripts.map((s) => s.id) } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.dripQueue.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function connection(platform: string, scopes = ['publish']) {
    const sealed = await sealTokens(h.keys, org, platform, {
      accessToken: `${platform}-access`,
      refreshToken: `${platform}-refresh`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes,
    });
    return db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: biz,
        platform,
        platformAccountId: `${platform}-acct-${randomUUID()}`,
        platformAccountName: 'Leeds Sourdough',
        ...sealed,
        scopes,
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });
  }

  async function project(options: {
    state?: string;
    platforms?: Array<{ platform: string; aspectRatio: string }>;
    publishPolicy?: 'MANUAL' | 'SCHEDULED';
    scheduledStartAt?: Date | null;
    targets?: unknown[];
  }) {
    const platforms = options.platforms ?? [{ platform: 'tiktok', aspectRatio: '9:16' }];
    const created = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: biz,
        createdByUserId: 'user-1',
        name: 'Friday sourdough',
        state: (options.state ?? 'APPROVED') as 'APPROVED',
        sourceType: 'BRIEF',
        language: 'fr',
        publishPolicy: options.publishPolicy ?? 'MANUAL',
        scheduledStartAt: options.scheduledStartAt ?? null,
        targetFormats: platforms.map((p) => ({ ...p, duration: 15 })),
        metadata: { runId: randomUUID() },
      },
    });
    const renders: Record<string, string> = {};
    const rows = [];
    for (const p of platforms) {
      const key = `orgs/${org}/renders/${randomUUID()}.mp4`;
      await h.deps.storage.put({
        bucket: 'renders',
        key,
        body: new Uint8Array(2048),
        contentType: 'video/mp4',
      });
      const render = await db.videoRender.create({
        data: {
          projectId: created.id,
          scriptId: `script-${p.platform}`,
          targetPlatform: p.platform,
          aspectRatio: p.aspectRatio,
          resolution: '1080x1920',
          durationSec: 15,
          fps: 30,
          bitrateKbps: 4500,
          s3Bucket: 'renders',
          s3Key: key,
          qualityCheckState: 'PASSED',
        },
      });
      renders[`script-${p.platform}`] = render.id;
      rows.push(render);
    }
    await db.videoProject.update({
      where: { id: created.id },
      data: {
        metadata: {
          runId: (created.metadata as { runId: string }).runId,
          renders,
          ...(options.targets && { autoPublish: { targets: options.targets } }),
        } as Prisma.InputJsonValue,
      },
    });
    return { project: created, renders: rows };
  }

  it('drip queue: PUT/GET, validation, capability and business scoping', async () => {
    const body = {
      slots: [{ weekday: 1, time: '08:30', timezone: 'Europe/London' }],
      platforms: ['tiktok'],
    };
    const put = (token: string, b: unknown = body, id = biz) =>
      call(dripRoute.PUT, { method: 'PUT', token, params: { id }, body: b });
    expect((await put('reader')).status).toBe(403);
    expect((await call(dripRoute.GET, { params: { id: biz } })).status).toBe(401);
    expect((await put('owner', { slots: [{ weekday: 9, time: '8', timezone: 'x' }] })).status).toBe(
      400,
    );
    const res = await put('owner');
    expect(res.status).toBe(200);
    expect(res.json.dripQueue).toMatchObject({
      platforms: ['tiktok'],
      enabled: true,
      queued: 0,
      staggerMinutes: 30,
    });
    expect((res.json.dripQueue as { nextSlotAt: string }).nextSlotAt).toMatch(/T0[78]:30:00/);
    expect(api.audits.map((a) => a.action)).toContain('studio.drip_queue.update');
    const got = await call(dripRoute.GET, { token: 'reader', params: { id: biz } });
    expect(got.json.dripQueue).toMatchObject({ slots: body.slots });
    // Another organisation using the same business id sees nothing.
    const other = await call(dripRoute.GET, { token: 'stranger', params: { id: biz } });
    expect(other.json.dripQueue).toBeNull();
  });

  it('approving a SCHEDULED project schedules each target, staggered from scheduledStartAt', async () => {
    const tt = await connection('tiktok');
    const ig = await connection('instagram');
    const start = new Date(Date.now() + 2 * 86_400_000);
    const { project: p } = await project({
      state: 'READY_FOR_REVIEW',
      publishPolicy: 'SCHEDULED',
      scheduledStartAt: start,
      platforms: [
        { platform: 'tiktok', aspectRatio: '9:16' },
        { platform: 'instagram_reel', aspectRatio: '9:16' },
      ],
      targets: [
        { platform: 'tiktok', connectionId: tt.id, caption: 'Friday!' },
        {
          platform: 'instagram_reel',
          connectionId: ig.id,
          caption: 'x'.repeat(2_200),
          hashtags: ['bread'],
        },
      ],
    });
    const res = await call(approveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: p.id },
      body: {},
    });
    expect(res.status).toBe(200);
    const scheduled = res.json.scheduled as Array<{ platform: string; scheduledFor: string }>;
    expect(scheduled.map((s) => s.platform)).toEqual(['tiktok', 'instagram_reel']);
    expect(Date.parse(scheduled[0]?.scheduledFor ?? '')).toBe(start.getTime());
    expect(Date.parse(scheduled[1]?.scheduledFor ?? '') - start.getTime()).toBe(30 * 60_000);
    const pubs = await db.videoPublication.findMany({
      where: { projectId: p.id },
      orderBy: { scheduledFor: 'asc' },
    });
    expect(pubs.map((x) => x.state)).toEqual(['SCHEDULED', 'SCHEDULED']);
    // 15.A9: the over-long auto caption was fitted, not refused.
    const igPub = pubs.find((x) => x.platform === 'instagram_reel');
    expect((igPub?.metadata as { captionTruncated?: boolean }).captionTruncated).toBe(true);
    expect([...(igPub?.caption ?? '')].length).toBeLessThanOrEqual(2200);
  });

  it('a SCHEDULED project without a start time takes the next free drip slot', async () => {
    const tt = await connection('tiktok');
    const make = () =>
      project({
        state: 'READY_FOR_REVIEW',
        publishPolicy: 'SCHEDULED',
        targets: [{ platform: 'tiktok', connectionId: tt.id }],
      });
    const first = await make();
    const second = await make();
    const approve = (id: string) =>
      call(approveRoute.POST, { method: 'POST', token: 'owner', params: { id }, body: {} });
    const a = (await approve(first.project.id)).json.scheduled as Array<{ scheduledFor: string }>;
    const b = (await approve(second.project.id)).json.scheduled as Array<{ scheduledFor: string }>;
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // One Monday 08:30 London slot per week: the second video takes the following week.
    const gap = Date.parse(b[0]?.scheduledFor ?? '') - Date.parse(a[0]?.scheduledFor ?? '');
    expect(Math.abs(gap - 7 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
    const slots = await db.autoPublishOutbox.findMany({
      where: { projectId: { in: [first.project.id, second.project.id] } },
      select: { slotAt: true },
    });
    expect(slots.every((s) => s.slotAt !== null)).toBe(true);
    const q = await call(dripRoute.GET, { token: 'owner', params: { id: biz } });
    expect((q.json.dripQueue as { queued: number }).queued).toBeGreaterThanOrEqual(2);
  });

  it('publications list carries latestMetrics from the latest snapshot', async () => {
    const { project: p, renders } = await project({});
    const pub = await db.videoPublication.create({
      data: {
        organisationId: org,
        projectId: p.id,
        renderId: renders[0]!.id,
        platform: 'tiktok',
        platformAccountId: 'acct',
        state: 'PUBLISHED',
        publishedAt: new Date(),
        platformPostId: `metrics-${randomUUID()}`,
        hashtags: [],
      },
    });
    await db.videoAnalytic.createMany({
      data: [
        {
          publicationId: pub.id,
          bucketAt: new Date(Date.now() - 7_200_000),
          bucketSize: 'hour',
          views: 10,
        },
        {
          publicationId: pub.id,
          bucketAt: new Date(Date.now() - 3_600_000),
          bucketSize: 'hour',
          views: 250,
          likes: 9,
          comments: 2,
        },
      ],
    });
    const res = await call(publicationsRoute.GET, {
      token: 'reader',
      path: `/api/studio/publications?projectId=${p.id}`,
    });
    const row = (
      res.json.data as Array<{ id: string; latestMetrics: unknown; analytics?: unknown }>
    ).find((r) => r.id === pub.id);
    expect(row?.latestMetrics).toMatchObject({ views: 250, likes: 9, comments: 2 });
    expect(row?.analytics).toBeUndefined();

    const best = await call(bestTimesRoute.GET, {
      token: 'reader',
      path: `/api/studio/analytics/best-times?platform=tiktok&businessId=${biz}&timezone=Europe/London`,
    });
    expect(best.status).toBe(200);
    expect(best.json).toMatchObject({ sufficientData: false, videos: 1, advisory: true });
    expect(
      (
        await call(bestTimesRoute.GET, {
          token: 'reader',
          path: '/api/studio/analytics/best-times?timezone=Nope',
        })
      ).status,
    ).toBe(400);
  });

  it('caption suggestions: one call per project, fitted, cached, tenant isolated', async () => {
    const { project: p } = await project({
      platforms: [
        { platform: 'tiktok', aspectRatio: '9:16' },
        { platform: 'x', aspectRatio: '16:9' },
        { platform: 'youtube_short', aspectRatio: '9:16' },
      ],
    });
    const noBrief = await call(suggestRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: p.id },
      body: {},
    });
    expect(noBrief.status).toBe(409);
    await db.videoBrief.create({
      data: {
        projectId: p.id,
        rawInput: 'sourdough',
        hook: 'Le vendredi, c’est sourdough',
        keyMessage: 'Pain frais',
        targetAudience: 'Leeds',
        tone: 'chaleureux',
        keywords: ['pain'],
        ideationModel: 'test',
      },
    });
    const first = await call(suggestRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: p.id },
      body: {},
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ language: 'fr', cached: false });
    const s = first.json.suggestions as Record<
      string,
      { caption: string; hashtags: string[]; captionTruncated?: boolean }
    >;
    expect(s.tiktok).toMatchObject({
      caption: 'Le vendredi, c’est sourdough',
      // 20.13: topped up to five from the other platforms' suggestions.
      hashtags: ['pain', 'leeds', 'a', 'b', 'c'],
    });
    expect(s.x?.hashtags).toEqual(['a', 'b', 'c', 'pain', 'leeds']);
    expect(s.x?.captionTruncated).toBe(true);
    // Missing from the model output → the brief's hook.
    expect(s.youtube_short?.caption).toBe('Le vendredi, c’est sourdough');
    const again = await call(suggestRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: p.id },
      body: {},
    });
    expect(again.json.cached).toBe(true);
    expect(
      (
        await call(suggestRoute.POST, {
          method: 'POST',
          token: 'reader',
          params: { id: p.id },
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(suggestRoute.POST, {
          method: 'POST',
          token: 'stranger',
          params: { id: p.id },
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(suggestRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: p.id },
          body: { nope: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('thumbnails: generate, upload (JPEG/PNG only), exposed on GET /renders/:id', async () => {
    const { renders } = await project({});
    const id = renders[0]!.id;
    const gen = await call(thumbnailRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      body: { source: 'keyframe', atSec: 1.2, overlayText: '3 tips' },
    });
    expect(gen.status).toBe(200);
    expect((gen.json.render as { thumbnailUrl: string }).thumbnailUrl).toBeTruthy();
    const firstKey = (await db.videoRender.findUniqueOrThrow({ where: { id } })).thumbnailS3Key;
    expect(firstKey).toMatch(/thumbnail-\d+\.jpg$/);
    expect(api.audits.find((a) => a.action === 'studio.render.thumbnail')).toMatchObject({
      metadata: { source: 'keyframe' },
    });
    expect(
      (
        await call(thumbnailRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id },
          body: { atSec: 99 },
        })
      ).status,
    ).toBe(400);

    const bad = new FormData();
    bad.set('file', new Blob([new TextEncoder().encode('<svg/>')], { type: 'image/png' }), 'x.png');
    const badBody = await multipart(bad);
    expect(
      (
        await call(thumbnailRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id },
          ...badBody,
        })
      ).status,
    ).toBe(400);
    const good = new FormData();
    good.set(
      'file',
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' }),
      't.png',
    );
    const up = await call(thumbnailRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      ...(await multipart(good)),
    });
    expect(up.status).toBe(200);
    const key = (await db.videoRender.findUniqueOrThrow({ where: { id } })).thumbnailS3Key;
    expect(key).toMatch(/\.png$/);
    expect(key).not.toBe(firstKey);

    const got = await call(renderRoute.GET, { token: 'reader', params: { id } });
    expect((got.json.render as { thumbnailUrl: string | null }).thumbnailUrl).toBeTruthy();
    expect(
      (
        await call(thumbnailRoute.POST, {
          method: 'POST',
          token: 'reader',
          params: { id },
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(thumbnailRoute.POST, {
          method: 'POST',
          token: 'stranger',
          params: { id },
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  it('captions: lines and SRT from the narration word timings, in the project language', async () => {
    const { renders } = await project({
      platforms: [{ platform: 'youtube', aspectRatio: '16:9' }],
    });
    const render = renders[0]!;
    const voice = await db.videoAsset.create({
      data: {
        organisationId: org,
        projectId: render.projectId,
        kind: 'AUDIO_VOICE',
        source: 'elevenlabs:v2',
        s3Bucket: 'assets',
        s3Key: `voice-${randomUUID()}.mp3`,
        metadata: {
          wordTiming: {
            status: 'ok',
            providerId: 'assemblyai',
            words: [
              { text: 'Bonjour', startSec: 0.2, endSec: 0.6 },
              { text: 'Leeds.', startSec: 0.6, endSec: 1.1 },
            ],
          },
        },
      },
    });
    const script = await db.videoScript.create({
      data: {
        projectId: render.projectId,
        targetPlatform: 'youtube',
        targetAspectRatio: '16:9',
        targetDurationSec: 15,
        fullText: 'Bonjour Leeds.',
        scriptModel: 'test',
      },
    });
    await db.videoShot.create({
      data: {
        scriptId: script.id,
        sortOrder: 0,
        durationSec: 3,
        visualTreatment: 'AI_CLIP',
        sceneDescription: 'bakery',
        voiceoverText: 'Bonjour Leeds.',
        voiceAssetId: voice.id,
        state: 'READY',
      },
    });
    await db.videoRender.update({ where: { id: render.id }, data: { scriptId: script.id } });
    const res = await call(captionsRoute.GET, { token: 'reader', params: { id: render.id } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      mode: 'srt',
      language: 'fr',
      lines: [{ text: 'Bonjour Leeds.', startAtSec: 0.2, endAtSec: 1.1 }],
    });
    expect(res.json.srtUrl).toBeTruthy();
    expect(
      (await db.videoRender.findUniqueOrThrow({ where: { id: render.id } })).captionsSrtS3Key,
    ).toMatch(/\.srt$/);
    expect(
      (await call(captionsRoute.GET, { token: 'stranger', params: { id: render.id } })).status,
    ).toBe(404);
  });

  it('YouTube quotaExceeded defers the publication to after the next Pacific-midnight reset', async () => {
    const { renders } = await project({
      platforms: [{ platform: 'youtube_short', aspectRatio: '9:16' }],
    });
    const yt = await connection('youtube');
    h.publishers.youtube_short.behaviour = () => {
      throw new PlatformError('youtube', 'quota_exceeded', 'quotaExceeded', false);
    };
    const res = await call(publicationsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: withHashtags({
        renderId: renders[0]!.id,
        platform: 'youtube_short',
        connectionId: yt.id,
        caption: 'Hi',
        title: 'Hi',
      }),
    });
    expect(res.status).toBe(202);
    const id = (res.json.publication as { id: string }).id;
    // Drain only the immediate job (the deferred one is delayed).
    // The inline queue ignores delays: the deferred retry runs at once, is refused again and
    // re-defers onto the same job id (deduplicated), so the drain settles.
    const drained = await drainInline(h.queue, h.deps);
    expect(drained.failedJobs).toEqual([]);
    expect(h.publishers.youtube_short.published.length).toBeGreaterThanOrEqual(1);
    const pub = await db.videoPublication.findUniqueOrThrow({ where: { id } });
    expect(pub.state).toBe('SCHEDULED');
    expect(pub.errorCode).toBe('quota_exceeded');
    const until = (pub.metadata as { quotaDeferredUntil: string }).quotaDeferredUntil;
    expect(Date.parse(until)).toBeGreaterThan(Date.now());
    expect(h.audits.map((a) => a.action)).toContain('studio.publication.quota_deferred');
  });
});
