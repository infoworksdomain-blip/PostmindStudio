import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as hashtagsRoute from '../../src/app/api/studio/businesses/[id]/hashtags/route';
import * as postCopyRoute from '../../src/app/api/studio/projects/[id]/post-copy/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// 20.13 — business hashtags, project post copy and the ≥ 5 hashtag rule at publish time, through
// the real routes and Postgres.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('20.13 captions and hashtags API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p20h-${randomUUID()}`;
  let businessId = '';
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    writer: tenant(org, ['studio:project:read', 'studio:project:write']),
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;

  beforeEach(async () => {
    h = createHarness(db);
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    if (!businessId) {
      const business = await db.business.create({
        data: { organisationId: org, name: 'Ahead Ai Ltd', createdByUserId: 'user-1' },
      });
      businessId = business.id;
    }
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
    await db.businessHashtagSettings.deleteMany({ where: { organisationId: org } });
    await db.business.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function connection() {
    const sealed = await sealTokens(h.keys, org, 'tiktok', {
      accessToken: 'tt-access',
      refreshToken: 'tt-refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['publish'],
    });
    return db.platformConnection.create({
      data: {
        organisationId: org,
        businessId,
        platform: 'tiktok',
        platformAccountId: `tt-${randomUUID()}`,
        platformAccountName: 'Ahead',
        ...sealed,
        scopes: ['publish'],
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });
  }

  async function project(metadata: Record<string, unknown> = {}) {
    const created = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId,
        createdByUserId: 'user-1',
        name: 'Friday bake',
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata: { runId: randomUUID(), ...metadata } as Prisma.InputJsonValue,
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
        projectId: created.id,
        scriptId: 'script-tiktok',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4500,
        s3Bucket: 'renders',
        s3Key: key,
        qualityCheckState: 'PASSED',
      },
    });
    return { project: created, render };
  }

  it('business hashtags: derived default, validation, save, audit and capabilities', async () => {
    const get = await call(hashtagsRoute.GET, { token: 'reader', params: { id: businessId } });
    expect(get.status).toBe(200);
    expect(get.json.hashtags).toMatchObject({
      primaryHashtag: 'AheadAI',
      derivedHashtag: 'AheadAI',
      custom: false,
      alwaysHashtags: [],
      minHashtags: 5,
    });
    const put = (token: string, body: unknown) =>
      call(hashtagsRoute.PUT, { method: 'PUT', token, params: { id: businessId }, body });
    expect((await put('reader', { primaryHashtag: 'X1' })).status).toBe(403);
    const bad = await put('owner', { primaryHashtag: 'two words' });
    expect(bad.status).toBe(400);
    expect((bad.json.details as { problem: string }).problem).toBe('characters');
    expect((await put('owner', { primaryHashtag: 'a'.repeat(31) })).status).toBe(400);
    expect((await put('owner', { alwaysHashtags: ['ok', 'bad-tag'] })).status).toBe(400);
    const ok = await put('owner', {
      primaryHashtag: '#AheadBakes',
      alwaysHashtags: ['#LeedsEats', 'aheadbakes', 'leedseats', 'Autumn2026'],
    });
    expect(ok.status).toBe(200);
    expect(ok.json.hashtags).toMatchObject({
      primaryHashtag: 'AheadBakes',
      custom: true,
      alwaysHashtags: ['LeedsEats', 'Autumn2026'],
    });
    expect(api.audits.map((a) => a.action)).toContain('studio.business.hashtags_update');
    // Back to the default.
    const reset = await put('owner', { primaryHashtag: null, alwaysHashtags: ['LeedsEats'] });
    expect(reset.json.hashtags).toMatchObject({ primaryHashtag: 'AheadAI', custom: false });
  });

  it('post copy: GET merges the policy; PUT enforces ≥ 5 and needs publication:write', async () => {
    const { project: p } = await project({
      captionSuggestions: {
        key: 'k',
        suggestions: { tiktok: { caption: 'Generated', hashtags: ['bread', 'cake'] } },
      },
    });
    const got = await call(postCopyRoute.GET, { token: 'reader', params: { id: p.id } });
    expect(got.status).toBe(200);
    const tiktok = (got.json.platforms as Record<string, Record<string, unknown>>).tiktok;
    expect(tiktok).toMatchObject({
      caption: 'Generated',
      source: 'generated',
      locked: ['AheadAI', 'LeedsEats'],
      hashtags: ['AheadAI', 'LeedsEats', 'bread', 'cake'],
      min: 5,
      max: 5,
    });
    const put = (token: string, hashtags: string[]) =>
      call(postCopyRoute.PUT, {
        method: 'PUT',
        token,
        params: { id: p.id },
        body: { platform: 'tiktok', caption: 'Hook first\nThen the rest', hashtags },
      });
    expect((await put('writer', ['a', 'b', 'c'])).status).toBe(403);
    const short = await put('owner', ['bread']);
    expect(short.status).toBe(400);
    expect((short.json.details as { code: string }).code).toBe('hashtags_minimum');
    const tooMany = await put('owner', ['a', 'b', 'c', 'd']);
    expect((tooMany.json.details as { code: string }).code).toBe('hashtags_maximum');
    const ok = await put('owner', ['bread', 'cake', 'buns']);
    expect(ok.status).toBe(200);
    expect((ok.json.copy as { hashtags: string[] }).hashtags).toEqual([
      'AheadAI',
      'LeedsEats',
      'bread',
      'cake',
      'buns',
    ]);
    expect(api.audits.map((a) => a.action)).toContain('studio.project.post_copy_update');
    const again = await call(postCopyRoute.GET, { token: 'owner', params: { id: p.id } });
    expect((again.json.platforms as Record<string, { source: string }>).tiktok?.source).toBe(
      'owner',
    );
  });

  it('POST /publications adds the business + always hashtags, tops up, or answers 400', async () => {
    const conn = await connection();
    const bare = await project();
    const post = (renderId: string, hashtags: string[]) =>
      call(publicationsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { renderId, platform: 'tiktok', connectionId: conn.id, caption: 'Hi', hashtags },
      });
    const short = await post(bare.render.id, ['bread']);
    expect(short.status).toBe(400);
    expect((short.json.details as { code: string }).code).toBe('hashtags_minimum');

    const suggested = await project({
      captionSuggestions: {
        key: 'k',
        suggestions: { tiktok: { caption: 'G', hashtags: ['sourdough', 'Leeds', 'Bakes'] } },
      },
    });
    const ok = await post(suggested.render.id, ['bread']);
    expect(ok.status).toBe(202);
    const pub = await db.videoPublication.findFirstOrThrow({
      where: { projectId: suggested.project.id },
    });
    expect(pub.hashtags).toEqual(['AheadAI', 'LeedsEats', 'bread', 'sourdough', 'Leeds']);
    expect(pub.caption).toBe('Hi\n\n#AheadAI #LeedsEats #bread #sourdough #Leeds');
    expect((pub.metadata as { hashtagsToppedUp: string[] }).hashtagsToppedUp).toEqual([
      'sourdough',
      'Leeds',
    ]);
  });

  it('editing the copy updates a scheduled publication not yet sent', async () => {
    const conn = await connection();
    const { project: p, render } = await project();
    const created = await call(publicationsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        renderId: render.id,
        platform: 'tiktok',
        connectionId: conn.id,
        caption: 'Old',
        hashtags: ['a1', 'a2', 'a3'],
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(created.status).toBe(202);
    const res = await call(postCopyRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: p.id },
      body: { platform: 'tiktok', caption: 'New caption', hashtags: ['b1', 'b2', 'b3'] },
    });
    expect(res.json.scheduledUpdated).toBe(1);
    const pub = await db.videoPublication.findFirstOrThrow({ where: { projectId: p.id } });
    expect(pub.caption).toBe('New caption\n\n#AheadAI #LeedsEats #b1 #b2 #b3');
    expect(pub.hashtags).toEqual(['AheadAI', 'LeedsEats', 'b1', 'b2', 'b3']);
  });
});
