import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mediaRoute from '../../src/app/api/studio/media/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { featureKeys } from '../../src/lib/studio/services/features';
import { call, installApi, tenant } from '../helpers/api-harness';

// 25.10 — GET /api/studio/media on Postgres: finished renders, READY uploaded videos and library
// images in one newest-first feed; capability, organisation and business scoping, type filter,
// keyset paging across the three tables, and the image-library feature switch.

const hasDb = Boolean(process.env.DATABASE_URL);

interface Item {
  type: string;
  id: string;
  createdAt: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  projectId?: string;
  projectState?: string;
  title?: string | null;
  kind?: string;
  width?: number | null;
}

describe.skipIf(!hasDb)('GET /api/studio/media', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-media-${randomUUID()}`;
  const other = `api-media-other-${randomUUID()}`;
  const noImages = `api-media-noimg-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    nope: tenant(org, ['studio:publication:write']),
    stranger: tenant(other),
    noImages: tenant(noImages),
  };
  const ids: Record<string, string> = {};
  const at = (minutesAgo: number) =>
    new Date(Date.parse('2026-10-07T12:00:00Z') - minutesAgo * 60_000);

  async function project(organisationId: string, businessId: string, name: string, extra = {}) {
    return db.videoProject.create({
      data: {
        organisationId,
        businessId,
        createdByUserId: 'user-1',
        name,
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 10 }],
        ...extra,
      },
    });
  }

  async function render(
    projectId: string,
    createdAt: Date,
    qualityCheckState: 'PASSED' | 'FAILED' | 'PENDING' | 'FORCE_APPROVED' = 'PASSED',
  ) {
    const row = await db.videoRender.create({
      data: {
        projectId,
        scriptId: 'script-x',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 21,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `r/${randomUUID()}.mp4`,
        thumbnailS3Key: `t/${randomUUID()}.jpg`,
        qualityCheckState,
        createdAt,
      },
    });
    return row.id;
  }

  async function upload(
    organisationId: string,
    businessId: string | null,
    createdAt: Date,
    kind: 'SOURCE_VIDEO' | 'DEMO_VIDEO' | 'SLIDE_CLIP' | 'BRAND_LOGO' = 'SOURCE_VIDEO',
    state: 'READY' | 'PENDING' | 'FAILED' = 'READY',
  ) {
    const row = await db.videoUpload.create({
      data: {
        organisationId,
        businessId,
        createdByUserId: 'user-1',
        kind,
        fileName: `${kind.toLowerCase()}.mp4`,
        contentType: 'video/mp4',
        declaredBytes: 1000,
        sizeBytes: 1000,
        durationSec: 12,
        widthPx: 1080,
        heightPx: 1920,
        s3Bucket: 'assets',
        s3Key: `u/${randomUUID()}.mp4`,
        state,
        expiresAt: createdAt,
        createdAt,
      },
    });
    return row.id;
  }

  async function image(organisationId: string, businessId: string, createdAt: Date) {
    const row = await db.imageLibraryItem.create({
      data: {
        organisationId,
        businessId,
        source: 'UPLOAD',
        s3Bucket: 'assets',
        s3Key: `i/${randomUUID()}.jpg`,
        widthPx: 1600,
        heightPx: 1200,
        fileSizeBytes: 2000,
        tags: [],
        altText: 'Loaves on a rack',
        fingerprint: randomUUID(),
        createdAt,
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    vi.stubEnv('S3_BUCKET_THUMBNAILS', 'thumbs');
    const a = await project(org, 'biz-a', 'Sourdough launch');
    const b = await project(org, 'biz-b', 'Gym opening');
    const gone = await project(org, 'biz-a', 'Deleted', { deletedAt: new Date() });
    const foreign = await project(other, 'biz-a', 'Not yours');
    ids.renderA = await render(a.id, at(10));
    ids.renderB = await render(b.id, at(30), 'FORCE_APPROVED');
    ids.failed = await render(a.id, at(5), 'FAILED');
    ids.pending = await render(a.id, at(4), 'PENDING');
    ids.deleted = await render(gone.id, at(3));
    ids.foreignRender = await render(foreign.id, at(2));
    ids.uploadA = await upload(org, 'biz-a', at(20));
    ids.demoA = await upload(org, 'biz-a', at(40), 'DEMO_VIDEO');
    ids.clip = await upload(org, 'biz-a', at(6), 'SLIDE_CLIP');
    ids.logo = await upload(org, 'biz-a', at(7), 'BRAND_LOGO');
    ids.pendingUpload = await upload(org, 'biz-a', at(8), 'SOURCE_VIDEO', 'PENDING');
    ids.foreignUpload = await upload(other, 'biz-a', at(1));
    ids.imageA = await image(org, 'biz-a', at(15));
    ids.imageB = await image(org, 'biz-b', at(50));
    ids.foreignImage = await image(other, 'biz-a', at(1));
    ids.noImagesImage = await image(noImages, 'biz-a', at(1));
    await db.systemFlag.create({
      data: { key: featureKeys.organisation('image-library', noImages), value: 'false' },
    });
  });

  beforeEach(() => {
    installApi(db, tokens);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setApiDeps(undefined);
    const orgs = [org, other, noImages];
    const projects = await db.videoProject.findMany({
      where: { organisationId: { in: orgs } },
      select: { id: true },
    });
    await db.videoRender.deleteMany({ where: { projectId: { in: projects.map((p) => p.id) } } });
    await db.videoProject.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.videoUpload.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.imageLibraryItem.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.systemFlag.deleteMany({ where: { key: { contains: noImages } } });
    await db.$disconnect();
  });

  const list = async (token: string, query: Record<string, string> = {}) => {
    const qs = new URLSearchParams(query).toString();
    const res = await call(mediaRoute.GET, {
      token,
      path: `/api/studio/media${qs ? `?${qs}` : ''}`,
    });
    return { ...res, data: (res.json.data ?? []) as Item[] };
  };

  it('needs a session and studio:project:read', async () => {
    expect((await call(mediaRoute.GET, {})).status).toBe(401);
    expect((await list('nope')).status).toBe(403);
    expect((await list('reader')).status).toBe(200);
  });

  it('lists finished renders, ready uploaded videos and images, newest first', async () => {
    const res = await list('owner');
    expect(res.status).toBe(200);
    expect(res.data.map((i) => i.id)).toEqual([
      ids.renderA,
      ids.imageA,
      ids.uploadA,
      ids.renderB,
      ids.demoA,
      ids.imageB,
    ]);
    const video = res.data[0];
    expect(video).toMatchObject({
      type: 'video',
      title: 'Sourdough launch',
      projectState: 'APPROVED',
      width: 1080,
    });
    expect(video?.thumbnailUrl).toMatch(/^https:\/\/signed\.example\/thumbs\/t\//);
    const upload = res.data.find((i) => i.id === ids.uploadA);
    expect(upload).toMatchObject({ type: 'upload', kind: 'source_video' });
    expect(upload?.previewUrl).toMatch(/^https:\/\/signed\.example\/assets\/u\//);
    expect(res.data.find((i) => i.id === ids.demoA)?.kind).toBe('demo_video');
    const img = res.data.find((i) => i.id === ids.imageA);
    expect(img?.type).toBe('image');
    expect(img?.previewUrl).toMatch(/^https:\/\/signed\.example\/assets\/i\//);
    // Never storage coordinates.
    expect(JSON.stringify(res.json)).not.toContain('s3Key');
    expect(res.json.nextCursor).toBeNull();
  });

  it("never shows another organisation's media", async () => {
    const mine = (await list('owner')).data.map((i) => i.id);
    for (const foreign of [ids.foreignRender, ids.foreignUpload, ids.foreignImage])
      expect(mine).not.toContain(foreign);
    const theirs = (await list('stranger')).data.map((i) => i.id);
    expect(theirs.sort()).toEqual([ids.foreignRender, ids.foreignUpload, ids.foreignImage].sort());
  });

  it('scopes to one business and filters by type', async () => {
    const bizA = await list('owner', { businessId: 'biz-a' });
    expect(bizA.data.map((i) => i.id)).toEqual([ids.renderA, ids.imageA, ids.uploadA, ids.demoA]);
    expect((await list('owner', { type: 'video' })).data.map((i) => i.id)).toEqual([
      ids.renderA,
      ids.renderB,
    ]);
    expect((await list('owner', { type: 'upload' })).data.map((i) => i.id)).toEqual([
      ids.uploadA,
      ids.demoA,
    ]);
    expect(
      (await list('owner', { type: 'image', businessId: 'biz-b' })).data.map((i) => i.id),
    ).toEqual([ids.imageB]);
  });

  it('pages with an opaque cursor across the three sources', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await list('owner', { limit: '2', ...(cursor ? { cursor } : {}) });
      seen.push(...res.data.map((i) => i.id));
      cursor = res.json.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(seen).toEqual([
      ids.renderA,
      ids.imageA,
      ids.uploadA,
      ids.renderB,
      ids.demoA,
      ids.imageB,
    ]);
    expect((await list('owner', { cursor: 'not-a-cursor' })).status).toBe(400);
    expect((await list('owner', { limit: '500' })).status).toBe(400);
    expect((await list('owner', { type: 'fonts' })).status).toBe(400);
  });

  it('leaves images out while the image library is switched off', async () => {
    expect((await list('noImages')).data).toEqual([]);
    expect((await list('noImages', { type: 'image' })).data).toEqual([]);
  });
});
