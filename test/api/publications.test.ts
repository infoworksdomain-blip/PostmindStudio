import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as cancelRoute from '../../src/app/api/studio/publications/[id]/cancel/route';
import * as retryRoute from '../../src/app/api/studio/publications/[id]/retry/route';
import * as publicationRoute from '../../src/app/api/studio/publications/[id]/route';
import * as takedownRoute from '../../src/app/api/studio/publications/[id]/takedown/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { PlatformError } from '../../src/lib/errors';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { withHashtags } from '../helpers/hashtags';

// BACKLOG 5.9–5.11: publish now, schedule, cancel, retry, take down — through the real routes,
// the real publish worker (inline queue) and Postgres, with recording fake publishers.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('publications API + publish worker', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-pub-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-pub-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness(db);
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing });
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
    await db.scheduledPublication.deleteMany({
      where: { publicationId: { in: pubs.map((p) => p.id) } },
    });
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function approvedRender(
    options: { aspectRatio?: string; state?: string; quality?: string } = {},
  ) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Publishable',
        state: (options.state ?? 'APPROVED') as 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata: { runId: randomUUID() },
      },
    });
    const key = `orgs/${org}/renders/${randomUUID()}.mp4`;
    await h.deps.storage.put({
      bucket: 'renders',
      key,
      body: new Uint8Array(2048),
      contentType: 'video/mp4',
    });
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: 'script-1',
        targetPlatform: 'tiktok',
        aspectRatio: options.aspectRatio ?? '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4500,
        s3Bucket: 'renders',
        s3Key: key,
        qualityCheckState: (options.quality ?? 'PASSED') as 'PASSED',
      },
    });
    return { project, render };
  }

  async function connection(platform: string, state = 'active') {
    const sealed = await sealTokens(h.keys, org, platform, {
      accessToken: `${platform}-access`,
      refreshToken: `${platform}-refresh`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['publish'],
    });
    return db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        platform,
        platformAccountId: `${platform}-acct-${randomUUID()}`,
        platformAccountName: 'Leeds Sourdough',
        ...sealed,
        scopes: ['publish'],
        state,
        connectedByUserId: 'user-1',
      },
    });
  }

  const publish = (body: unknown, token = 'owner') =>
    call(publicationsRoute.POST, { method: 'POST', token, body: withHashtags(body) });

  it('publishes now: worker uploads, marks PUBLISHED, attributes and rolls up the project', async () => {
    const { project, render } = await approvedRender();
    const conn = await connection('tiktok');

    const res = await publish({
      renderId: render.id,
      platform: 'tiktok',
      connectionId: conn.id,
      caption: 'Fresh sourdough, every week',
      hashtags: ['#Leeds', 'sourdough'],
    });
    expect(res.status).toBe(202);
    const created = res.json.publication as { id: string; state: string };
    expect(created.state).toBe('SCHEDULED');
    expect((await db.videoProject.findUnique({ where: { id: project.id } }))?.state).toBe(
      'PUBLISHING',
    );

    const drained = await drainInline(h.queue, h.deps);
    expect(drained.failedJobs).toEqual([]);

    const sent = h.publishers.tiktok.published[0];
    expect(sent?.accessToken).toBe('tiktok-access');
    expect(sent?.accountId).toBe(conn.platformAccountId);
    expect(sent?.aiGenerated).toBe(true);
    expect(sent?.video.sizeBytes).toBe(2048);

    const got = await call(publicationRoute.GET, { token: 'owner', params: { id: created.id } });
    const publication = got.json.publication as Record<string, unknown>;
    expect(publication.state).toBe('PUBLISHED');
    expect(publication.platformPostId).toMatch(/^fake_tiktok_1_/);
    expect((await db.videoProject.findUnique({ where: { id: project.id } }))?.state).toBe(
      'PUBLISHED',
    );
    expect(h.attributions).toEqual([
      expect.objectContaining({
        publicationId: created.id,
        platformPostId: publication.platformPostId,
      }),
    ]);
    expect(h.audits.map((a) => a.action)).toContain('studio.publication.published');
  });

  it('uses Core-registered Meta credentials for Instagram with the platformAccountId', async () => {
    const { render } = await approvedRender();
    const unregistered = await publish({
      renderId: render.id,
      platform: 'instagram_reel',
      platformAccountId: 'ig-unknown',
    });
    expect(unregistered.status).toBe(400);
    const ig = await connection('instagram');
    const res = await publish({
      renderId: render.id,
      platform: 'instagram_reel',
      platformAccountId: ig.platformAccountId,
      caption: 'Reel time',
    });
    expect(res.status).toBe(202);
    await drainInline(h.queue, h.deps);
    expect(h.publishers.instagram_reel.published[0]?.accountId).toBe(ig.platformAccountId);
    expect(h.publishers.instagram_reel.published[0]?.accessToken).toBe('meta-token');
  });

  it('rejects bad requests before anything is queued', async () => {
    const draft = await approvedRender({ state: 'READY_FOR_REVIEW' });
    const failedQc = await approvedRender({ quality: 'FAILED' });
    const landscape = await approvedRender({ aspectRatio: '16:9' });
    const ok = await approvedRender();
    const conn = await connection('tiktok');
    const stale = await connection('tiktok', 'needs_reconnect');
    const base = { platform: 'tiktok', connectionId: conn.id };

    expect((await publish({ ...base, renderId: draft.render.id })).status).toBe(409);
    expect((await publish({ ...base, renderId: failedQc.render.id })).status).toBe(409);
    const shape = await publish({ ...base, renderId: landscape.render.id });
    expect(shape.status).toBe(400);
    expect(JSON.stringify(shape.json)).toContain('9:16');
    expect((await publish({ renderId: ok.render.id, platform: 'tiktok' })).status).toBe(400);
    expect(
      (await publish({ renderId: ok.render.id, platform: 'tiktok', connectionId: stale.id }))
        .status,
    ).toBe(409);
    expect(
      (
        await publish({
          renderId: ok.render.id,
          platform: 'instagram_reel',
          connectionId: conn.id,
        })
      ).status,
    ).toBe(400);
    expect((await publish({ ...base, renderId: ok.render.id }, 'reader')).status).toBe(403);
    expect((await publish({ ...base, renderId: ok.render.id }, 'stranger')).status).toBe(404);
    expect(
      (
        await publish({
          ...base,
          renderId: ok.render.id,
          scheduledFor: new Date(Date.now() + 10_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    // 20.3: the upper bound — more than 180 days ahead is refused too.
    const tooFar = await publish({
      ...base,
      renderId: ok.render.id,
      scheduledFor: new Date(Date.now() + 181 * 86_400_000).toISOString(),
    });
    expect(tooFar.status).toBe(400);
    expect(JSON.stringify(tooFar.json)).toContain('180 days');
    expect(h.queue.pending).toEqual([]);
  });

  it('refuses a duplicate publication of the same render to the same account', async () => {
    const { render } = await approvedRender();
    const conn = await connection('tiktok');
    const body = { renderId: render.id, platform: 'tiktok', connectionId: conn.id };
    expect((await publish(body)).status).toBe(202);
    const dup = await publish(body);
    expect(dup.status).toBe(409);
  });

  it('schedules, fires later, and can be cancelled before it fires', async () => {
    const conn = await connection('tiktok');
    const later = new Date(Date.now() + 3_600_000).toISOString();

    const a = await approvedRender();
    const scheduled = await publish({
      renderId: a.render.id,
      platform: 'tiktok',
      connectionId: conn.id,
      scheduledFor: later,
    });
    expect(scheduled.status).toBe(202);
    const aId = (scheduled.json.publication as { id: string }).id;
    expect(h.queue.pending.map((j) => j.name)).toEqual(['fire-scheduled-publication']);
    const row = await db.scheduledPublication.findUnique({ where: { publicationId: aId } });
    expect(row?.state).toBe('PENDING');
    expect(row?.jobId).toBeTruthy();

    const cancelled = await call(cancelRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: aId },
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.json.publication as { state: string }).state).toBe('CANCELLED');
    await drainInline(h.queue, h.deps);
    expect(h.publishers.tiktok.published).toHaveLength(0);
    const again = await call(cancelRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: aId },
    });
    expect(again.status).toBe(409);

    // A second scheduled publication fires (the inline queue ignores the delay) and publishes.
    const b = await approvedRender();
    const second = await publish({
      renderId: b.render.id,
      platform: 'tiktok',
      connectionId: conn.id,
      scheduledFor: later,
    });
    const bId = (second.json.publication as { id: string }).id;
    await drainInline(h.queue, h.deps);
    expect((await db.videoPublication.findUnique({ where: { id: bId } }))?.state).toBe('PUBLISHED');
    expect(
      (await db.scheduledPublication.findUnique({ where: { publicationId: bId } }))?.state,
    ).toBe('FIRED');
  });

  it('records a platform failure, then retries it to success', async () => {
    const { project, render } = await approvedRender();
    const conn = await connection('youtube');
    h.publishers.youtube_short.behaviour = () => {
      throw new PlatformError(
        'youtube_short',
        'content_policy',
        'Video rejected by platform',
        false,
      );
    };
    const res = await publish({
      renderId: render.id,
      platform: 'youtube_short',
      connectionId: conn.id,
      caption: 'Bread',
    });
    const id = (res.json.publication as { id: string }).id;
    await drainInline(h.queue, h.deps);

    const failed = await db.videoPublication.findUniqueOrThrow({ where: { id } });
    expect(failed.state).toBe('FAILED');
    expect(failed.errorCode).toBe('content_policy');
    expect(failed.retryCount).toBe(1);
    expect((await db.videoProject.findUnique({ where: { id: project.id } }))?.state).toBe(
      'PARTIALLY_PUBLISHED',
    );

    h.publishers.youtube_short.behaviour = () => ({
      platformPostId: 'yt-ok',
      platformUrl: null,
      metadata: {},
    });
    const retried = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
    });
    expect(retried.status).toBe(202);
    await drainInline(h.queue, h.deps);
    const ok = await db.videoPublication.findUniqueOrThrow({ where: { id } });
    expect(ok.state).toBe('PUBLISHED');
    expect(ok.errorCode).toBeNull();
    expect((await db.videoProject.findUnique({ where: { id: project.id } }))?.state).toBe(
      'PUBLISHED',
    );
    const notFailed = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
    });
    expect(notFailed.status).toBe(409);
  });

  it('never uploads twice after an ambiguous failure; an explicit retry is the confirmation', async () => {
    const { render } = await approvedRender();
    const conn = await connection('youtube');
    // A timeout mid-upload: the video may be live. BullMQ retries, but the next attempt must
    // refuse to upload again and fail as outcome_unknown for a person to check.
    h.publishers.youtube_short.behaviour = () => {
      throw new PlatformError('youtube_short', 'timeout', 'Upload timed out', true);
    };
    const res = await publish({
      renderId: render.id,
      platform: 'youtube_short',
      connectionId: conn.id,
      caption: 'Bread',
    });
    const id = (res.json.publication as { id: string }).id;
    await drainInline(h.queue, h.deps);

    expect(h.publishers.youtube_short.published).toHaveLength(1);
    const failed = await db.videoPublication.findUniqueOrThrow({ where: { id } });
    expect(failed.state).toBe('FAILED');
    expect(failed.errorCode).toBe('outcome_unknown');
    expect(failed.errorReason).toMatch(/not published twice/);

    h.publishers.youtube_short.behaviour = () => ({
      platformPostId: 'yt-after-check',
      platformUrl: null,
      metadata: {},
    });
    const retried = await call(retryRoute.POST, { method: 'POST', token: 'owner', params: { id } });
    expect(retried.status).toBe(202);
    await drainInline(h.queue, h.deps);
    const ok = await db.videoPublication.findUniqueOrThrow({ where: { id } });
    expect(ok.state).toBe('PUBLISHED');
    expect(h.publishers.youtube_short.published).toHaveLength(2);
    expect((ok.metadata as Record<string, unknown>).uploadStartedAt).toBeUndefined();
  });

  it('retries a definite platform refusal automatically (nothing was posted)', async () => {
    const { render } = await approvedRender();
    const conn = await connection('youtube');
    let calls = 0;
    h.publishers.youtube_short.behaviour = () => {
      calls += 1;
      if (calls === 1) {
        throw new PlatformError('youtube_short', 'rate_limited', 'Slow down', true);
      }
      return { platformPostId: `yt-${randomUUID()}`, platformUrl: null, metadata: {} };
    };
    const res = await publish({
      renderId: render.id,
      platform: 'youtube_short',
      connectionId: conn.id,
      caption: 'Bread',
    });
    const id = (res.json.publication as { id: string }).id;
    await drainInline(h.queue, h.deps);
    const ok = await db.videoPublication.findUniqueOrThrow({ where: { id } });
    expect(ok.state).toBe('PUBLISHED');
    expect(calls).toBe(2);
  });

  it('takes down where the platform allows it and refuses cleanly where it does not', async () => {
    const yt = await approvedRender();
    const ytConn = await connection('youtube');
    const ytRes = await publish({
      renderId: yt.render.id,
      platform: 'youtube_short',
      connectionId: ytConn.id,
      caption: 'Sourdough at dawn',
    });
    const tt = await approvedRender();
    const ttConn = await connection('tiktok');
    const ttRes = await publish({
      renderId: tt.render.id,
      platform: 'tiktok',
      connectionId: ttConn.id,
    });
    await drainInline(h.queue, h.deps);

    const ytId = (ytRes.json.publication as { id: string }).id;
    const down = await call(takedownRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: ytId },
    });
    expect(down.status).toBe(200);
    expect((down.json.publication as { state: string }).state).toBe('TAKEN_DOWN');
    expect(h.publishers.youtube_short.takenDown[0]?.accessToken).toBe('youtube-access');

    const ttId = (ttRes.json.publication as { id: string }).id;
    const refused = await call(takedownRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: ttId },
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json)).toContain('no documented delete API');

    const strangers = await call(publicationRoute.GET, {
      token: 'stranger',
      params: { id: ttId },
    });
    expect(strangers.status).toBe(404);
  });

  it('lists publications filtered by platform and state, and paginates with a cursor', async () => {
    const tiktokConn = await connection('tiktok');
    const ytConn = await connection('youtube');
    const a = await approvedRender();
    const b = await approvedRender();
    const c = await approvedRender();

    const pubA = await publish({
      renderId: a.render.id,
      platform: 'tiktok',
      connectionId: tiktokConn.id,
    });
    const pubB = await publish({
      renderId: b.render.id,
      platform: 'tiktok',
      connectionId: tiktokConn.id,
    });
    const pubC = await publish({
      renderId: c.render.id,
      platform: 'youtube_short',
      connectionId: ytConn.id,
      title: 'Sourdough shorts',
    });
    const ids = [pubA, pubB, pubC].map((r) => (r.json.publication as { id: string }).id);

    const byPlatform = await call(publicationsRoute.GET, {
      token: 'owner',
      path: '/api/studio/publications?platform=tiktok',
    });
    expect(byPlatform.status).toBe(200);
    const platformIds = (byPlatform.json.data as Array<{ id: string }>).map((p) => p.id);
    expect(platformIds).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    expect(platformIds).not.toContain(ids[2]);

    const byState = await call(publicationsRoute.GET, {
      token: 'owner',
      path: '/api/studio/publications?state=SCHEDULED',
    });
    expect(byState.status).toBe(200);
    expect((byState.json.data as unknown[]).length).toBeGreaterThanOrEqual(3);

    const badState = await call(publicationsRoute.GET, {
      token: 'owner',
      path: '/api/studio/publications?state=NOT_A_STATE',
    });
    expect(badState.status).toBe(400);

    const page1 = await call(publicationsRoute.GET, {
      token: 'owner',
      path: '/api/studio/publications?limit=1',
    });
    expect(page1.status).toBe(200);
    expect((page1.json.data as unknown[]).length).toBe(1);
    const cursor = page1.json.nextCursor as string;
    expect(cursor).toBeTruthy();

    const page2 = await call(publicationsRoute.GET, {
      token: 'owner',
      path: `/api/studio/publications?limit=1&cursor=${cursor}`,
    });
    expect(page2.status).toBe(200);
    const firstId = (page1.json.data as Array<{ id: string }>)[0]?.id;
    const secondId = (page2.json.data as Array<{ id: string }>)[0]?.id;
    expect(secondId).not.toBe(firstId);
  });

  it('list is scoped to the caller organisation: another org sees none of these', async () => {
    const conn = await connection('tiktok');
    const render = await approvedRender();
    await publish({ renderId: render.render.id, platform: 'tiktok', connectionId: conn.id });

    const strangers = await call(publicationsRoute.GET, { token: 'stranger' });
    expect(strangers.status).toBe(200);
    expect(strangers.json.data).toEqual([]);
  });
});
