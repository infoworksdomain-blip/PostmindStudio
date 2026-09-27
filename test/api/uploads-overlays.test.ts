import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as overlayRoute from '../../src/app/api/studio/overlays/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as renderOverlaysRoute from '../../src/app/api/studio/renders/[id]/overlays/route';
import * as slideOverlaysRoute from '../../src/app/api/studio/slides/[id]/overlays/route';
import * as slideRoute from '../../src/app/api/studio/slides/[id]/route';
import * as completeRoute from '../../src/app/api/studio/uploads/[id]/complete/route';
import * as uploadsRoute from '../../src/app/api/studio/uploads/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { MediaInspector, MediaProbe } from '../../src/lib/studio/pipeline/media-probe';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import type { UploadDeps } from '../../src/lib/studio/uploads/signer';
import { call, installApi, tenant } from '../helpers/api-harness';
import { memoryStorage } from '../helpers/memory-storage';

// Phase 13.5 uploads (POST /uploads, /uploads/:id/complete, POST /projects sourceType UPLOAD),
// 13.3 GET /renders/:id/overlays and 13.4 GET|POST /slides/:id/overlays.

const hasDb = Boolean(process.env.DATABASE_URL);

const PROBE: MediaProbe = {
  durationSec: 41.2,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  videoProfile: 'High',
  audioCodec: 'aac',
  formatName: 'mov,mp4',
  bitRateKbps: 4000,
};

describe.skipIf(!hasDb)('uploads, whole-video and slide overlays API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-a1u-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-a1u-other-${randomUUID()}`),
  };
  let api: ReturnType<typeof installApi>;
  let mem: ReturnType<typeof memoryStorage>;
  let probe: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await seedOverlayPresets(db);
  });

  beforeEach(() => {
    api = installApi(db, tokens);
    mem = memoryStorage();
    probe = vi.fn(async () => PROBE);
    const uploads: UploadDeps = {
      signer: { presignPut: vi.fn(async ({ key }) => `https://s3.test/${key}?X-Amz-Signature=x`) },
      media: { probe } as unknown as MediaInspector,
      storage: mem.storage,
      bucket: 'assets',
    };
    api.deps.uploads = uploads;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.textOverlay.deleteMany({ where: { slide: { projectId: { in: ids } } } });
    await db.textOverlay.deleteMany({
      where: { renderId: { not: null }, text: { startsWith: org } },
    });
    await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { organisationId: org } });
    await db.videoUpload.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const createUpload = (body: Record<string, unknown>, token = 'owner') =>
    call(uploadsRoute.POST, { method: 'POST', token, body });
  const complete = (id: string, token = 'owner') =>
    call(completeRoute.POST, { method: 'POST', token, params: { id } });
  const sourceBody = {
    kind: 'source_video',
    contentType: 'video/mp4',
    sizeBytes: 48_211_000,
    fileName: 'shop-tour.mp4',
    businessId: 'biz',
  };

  async function slideshow(state = 'DRAFT' as const) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Slides',
        state,
        sourceType: 'SLIDESHOW',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 10 }],
        metadata: {},
      },
    });
    const slide = await db.slideshowSlide.create({
      data: {
        projectId: project.id,
        sortOrder: 0,
        slideType: 'IMAGE_STILL',
        durationSec: 3,
        metadata: { text: 'Bake #3' },
      },
    });
    return { project, slide };
  }

  it('POST /uploads returns a presigned PUT and enforces type and size limits', async () => {
    const res = await createUpload(sourceBody);
    expect(res.status).toBe(201);
    const upload = res.json.upload as Record<string, unknown>;
    expect(upload).toMatchObject({
      kind: 'source_video',
      state: 'PENDING',
      maxBytes: 524_288_000,
      headers: { 'content-type': 'video/mp4' },
    });
    expect(String(upload.putUrl)).toContain(`orgs/${org}/uploads/${String(upload.id)}/source.mp4`);
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.upload.create' });

    expect((await createUpload({ ...sourceBody, sizeBytes: 600 * 1024 * 1024 })).status).toBe(413);
    expect((await createUpload({ ...sourceBody, contentType: 'image/png' })).status).toBe(400);
    expect((await createUpload({ ...sourceBody, fileName: '../x.mp4' })).status).toBe(400);
    expect((await createUpload({ ...sourceBody, kind: 'slide_clip' })).status).toBe(400);
    expect((await createUpload(sourceBody, 'reader')).status).toBe(403);
    expect((await call(uploadsRoute.POST, { method: 'POST', body: sourceBody })).status).toBe(401);
  });

  it('complete: waits for the file, probes it, then is idempotent; bad files are removed', async () => {
    const created = await createUpload(sourceBody);
    const upload = created.json.upload as { id: string };
    expect((await complete(upload.id)).status).toBe(400); // not uploaded yet
    const row = await db.videoUpload.findUniqueOrThrow({ where: { id: upload.id } });
    await mem.storage.put({
      bucket: 'assets',
      key: row.s3Key,
      body: new Uint8Array(10),
      contentType: 'video/mp4',
    });
    expect((await complete(upload.id, 'stranger')).status).toBe(404);
    const done = await complete(upload.id);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      upload: { state: 'READY', durationSec: 41.2, width: 1080, height: 1920, sizeBytes: 10 },
      asset: null,
    });
    expect((await complete(upload.id)).status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);

    // A file ffprobe cannot read is rejected and deleted.
    const bad = (await createUpload(sourceBody)).json.upload as { id: string };
    const badRow = await db.videoUpload.findUniqueOrThrow({ where: { id: bad.id } });
    await mem.storage.put({
      bucket: 'assets',
      key: badRow.s3Key,
      body: new Uint8Array(3),
      contentType: 'video/mp4',
    });
    probe.mockRejectedValueOnce(new Error('ffprobe failed'));
    expect((await complete(bad.id)).status).toBe(400);
    expect(mem.objects.has(`assets/${badRow.s3Key}`)).toBe(false);
    expect((await complete(bad.id)).status).toBe(409);

    // Too long a video is rejected too.
    const long = (await createUpload(sourceBody)).json.upload as { id: string };
    const longRow = await db.videoUpload.findUniqueOrThrow({ where: { id: long.id } });
    await mem.storage.put({
      bucket: 'assets',
      key: longRow.s3Key,
      body: new Uint8Array(3),
      contentType: 'video/mp4',
    });
    probe.mockResolvedValueOnce({ ...PROBE, durationSec: 3_600 });
    const tooLong = await complete(long.id);
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.json.message)).toMatch(/at most/);
  });

  it('POST /projects sourceType UPLOAD claims a READY upload once', async () => {
    const upload = (await createUpload(sourceBody)).json.upload as { id: string };
    const project = (uploadId: string) =>
      call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: {
          name: 'Shop tour',
          businessId: 'biz',
          sourceType: 'UPLOAD',
          uploadId,
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
        },
      });
    expect((await project(upload.id)).status).toBe(400); // not complete
    const row = await db.videoUpload.findUniqueOrThrow({ where: { id: upload.id } });
    await mem.storage.put({
      bucket: 'assets',
      key: row.s3Key,
      body: new Uint8Array(5),
      contentType: 'video/mp4',
    });
    await complete(upload.id);
    const res = await project(upload.id);
    expect(res.status).toBe(201);
    const created = res.json.project as { id: string; sourceType: string; sourceRef: string };
    expect(created).toMatchObject({ sourceType: 'UPLOAD', sourceRef: upload.id });
    const claimed = await db.videoUpload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(claimed.projectId).toBe(created.id);
    const asset = await db.videoAsset.findUniqueOrThrow({ where: { id: claimed.assetId ?? '' } });
    expect(asset).toMatchObject({ kind: 'VIDEO_CLIP', projectId: created.id, durationSec: 41.2 });
    expect((await project(upload.id)).status).toBe(409);
    const missing = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'x',
        businessId: 'biz',
        sourceType: 'UPLOAD',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
      },
    });
    expect(missing.status).toBe(400);
  });

  it('slide clip uploads become assets of the slideshow', async () => {
    const { project } = await slideshow();
    const res = await createUpload({
      kind: 'slide_clip',
      contentType: 'video/quicktime',
      sizeBytes: 1_000,
      fileName: 'clip.mov',
      projectId: project.id,
    });
    expect(res.status).toBe(201);
    const upload = res.json.upload as { id: string; projectId: string };
    expect(upload.projectId).toBe(project.id);
    const row = await db.videoUpload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(row.s3Key.endsWith('.mov')).toBe(true);
    await mem.storage.put({
      bucket: 'assets',
      key: row.s3Key,
      body: new Uint8Array(5),
      contentType: 'video/quicktime',
    });
    probe.mockResolvedValueOnce({ ...PROBE, durationSec: 6 });
    const done = await complete(upload.id);
    expect(done.status).toBe(200);
    const asset = done.json.asset as { id: string; durationSec: number };
    expect(asset.durationSec).toBe(6);
    expect(await db.videoAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({
      projectId: project.id,
      kind: 'VIDEO_CLIP',
    });
    const brief = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Not a slideshow',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    const notSlideshow = await createUpload({
      kind: 'slide_clip',
      contentType: 'video/mp4',
      sizeBytes: 1_000,
      fileName: 'c.mp4',
      projectId: brief.id,
    });
    expect(notSlideshow.status).toBe(409);
  });

  it('GET|POST /slides/:id/overlays: whole-slide default timing, edits, cascade on delete', async () => {
    const { slide } = await slideshow();
    const post = (body: unknown, token = 'owner') =>
      call(slideOverlaysRoute.POST, { method: 'POST', token, params: { id: slide.id }, body });
    const res = await post({ text: 'Bake #3' });
    expect(res.status).toBe(201);
    const overlay = res.json.overlay as { id: string; slideId: string; endAtSec: number };
    expect(overlay).toMatchObject({ slideId: slide.id, startAtSec: 0, endAtSec: 3 });
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.overlay.create',
      metadata: expect.objectContaining({ slideId: slide.id }),
    });
    expect((await post({ text: 'late', startAtSec: 1, endAtSec: 9 })).status).toBe(400);
    expect((await post({ text: 'x' }, 'reader')).status).toBe(403);
    expect((await post({ text: 'x' }, 'stranger')).status).toBe(404);

    const list = await call(slideOverlaysRoute.GET, { token: 'reader', params: { id: slide.id } });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(
      (await call(slideOverlaysRoute.GET, { token: 'stranger', params: { id: slide.id } })).status,
    ).toBe(404);

    // The generic overlay endpoints work for slide overlays too.
    const patch = await call(overlayRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: overlay.id },
      body: { text: 'Bake #4', style: { fillColor: '#FFFFFF80' } },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.overlay).toMatchObject({ text: 'Bake #4', fillColor: '#FFFFFF80' });

    const del = await call(slideRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: slide.id },
    });
    expect([200, 204]).toContain(del.status);
    expect(await db.textOverlay.count({ where: { id: overlay.id } })).toBe(0);
  });

  it('GET /renders/:id/overlays lists the whole-video overlays for that platform', async () => {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Rendered',
        state: 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    const render = (platform: string) =>
      db.videoRender.create({
        data: {
          projectId: project.id,
          scriptId: 'script',
          targetPlatform: platform,
          aspectRatio: '9:16',
          resolution: '1080x1920',
          durationSec: 30,
          fps: 30,
          bitrateKbps: 4000,
          s3Bucket: 'renders',
          s3Key: 'r.mp4',
          qualityCheckState: 'PASSED',
        },
      });
    const [old, current, other] = [
      await render('tiktok'),
      await render('tiktok'),
      await render('youtube'),
    ];
    const watermark = (renderId: string, text: string) =>
      db.textOverlay.create({
        data: {
          renderId,
          text: `${org} ${text}`,
          startAtSec: 0,
          endAtSec: 30,
          animationIn: 'fadeIn',
          animationOut: 'fadeOut',
          fontFamily: 'Inter',
          fontSizePct: 4,
          fillColor: '#FFFFFF',
          anchorX: 0.9,
          anchorY: 0.1,
        },
      });
    await watermark(old.id, '@leedssourdough');
    await watermark(other.id, 'youtube only');
    const res = await call(renderOverlaysRoute.GET, {
      token: 'reader',
      params: { id: current.id },
    });
    expect(res.status).toBe(200);
    expect((res.json.data as Array<{ text: string }>).map((o) => o.text)).toEqual([
      `${org} @leedssourdough`,
    ]);
    expect(
      (await call(renderOverlaysRoute.GET, { token: 'stranger', params: { id: current.id } }))
        .status,
    ).toBe(404);
    expect((await call(renderOverlaysRoute.GET, { params: { id: current.id } })).status).toBe(401);
  });
});
