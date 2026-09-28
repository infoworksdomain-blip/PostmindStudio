import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandKitRoute from '../../src/app/api/studio/brand-kits/[id]/route';
import * as brandKitsRoute from '../../src/app/api/studio/brand-kits/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as completeRoute from '../../src/app/api/studio/uploads/[id]/complete/route';
import * as uploadsRoute from '../../src/app/api/studio/uploads/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { MediaInspector } from '../../src/lib/studio/pipeline/media-probe';
import type { UploadDeps } from '../../src/lib/studio/uploads/signer';
import { call, installApi, tenant } from '../helpers/api-harness';
import { fakeTtf } from '../helpers/fake-font';
import { memoryStorage } from '../helpers/memory-storage';

// Phase 15 Track B API: 15.B1 brand-kit media uploads (kinds brand_logo / brand_watermark /
// brand_card / brand_font with licence confirmation), PATCH brand-kit media + uploaded fonts +
// P6 AI label, soft DELETE; 15.B7 PATCH /projects/:id { renderOptions } with the 4K tier check.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('composition media API (Phase 15 Track B)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p15b-${randomUUID()}`;
  const plus = tenant(org);
  plus.organisation = { id: org, planTier: 'PLUS' };
  const tokens = {
    owner: tenant(org),
    plus,
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-p15b-other-${randomUUID()}`),
  };
  let api: ReturnType<typeof installApi>;
  let mem: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    api = installApi(db, tokens);
    mem = memoryStorage();
    const uploads: UploadDeps = {
      signer: { presignPut: vi.fn(async ({ key }) => `https://s3.test/${key}?sig`) },
      media: {
        probe: vi.fn(async () => ({
          durationSec: 4,
          width: 1080,
          height: 1920,
          fps: 30,
          videoCodec: 'h264',
          videoProfile: 'High',
          audioCodec: null,
          formatName: 'mp4',
          bitRateKbps: 1,
        })),
      } as unknown as MediaInspector,
      storage: mem.storage,
      bucket: 'assets',
    };
    api.deps.uploads = uploads;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.brandKit.deleteMany({ where: { organisationId: org } });
    await db.videoUpload.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const createUpload = (body: Record<string, unknown>, token = 'owner') =>
    call(uploadsRoute.POST, { method: 'POST', token, body });
  const complete = (id: string, token = 'owner') =>
    call(completeRoute.POST, { method: 'POST', token, params: { id } });

  /** Create, "PUT" the bytes into memory storage, complete. */
  async function uploadBrand(kind: string, contentType: string, bytes: Uint8Array, extra = {}) {
    const res = await createUpload({
      kind,
      contentType,
      sizeBytes: bytes.byteLength,
      fileName: `f.${contentType.split('/')[1]}`,
      businessId: 'biz-1',
      ...extra,
    });
    expect(res.status).toBe(201);
    const upload = res.json.upload as { id: string };
    const row = await db.videoUpload.findUniqueOrThrow({ where: { id: upload.id } });
    await mem.storage.put({ bucket: row.s3Bucket, key: row.s3Key, body: bytes, contentType });
    return { id: upload.id, completed: await complete(upload.id) };
  }

  const transparentPng = async () =>
    new Uint8Array(
      await sharp({
        create: {
          width: 300,
          height: 150,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer(),
    );
  const opaquePng = async () =>
    new Uint8Array(
      await sharp({ create: { width: 300, height: 150, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    );

  it('POST /uploads validates brand kinds: type, businessId and the font licence', async () => {
    const base = {
      contentType: 'image/png',
      sizeBytes: 10,
      fileName: 'l.png',
      businessId: 'biz-1',
    };
    expect(
      (await createUpload({ ...base, kind: 'brand_logo', contentType: 'image/jpeg' })).status,
    ).toBe(400);
    expect(
      (await createUpload({ ...base, kind: 'brand_logo', businessId: undefined })).status,
    ).toBe(400);
    expect((await createUpload({ ...base, kind: 'source_video' })).status).toBe(400);
    const font = {
      kind: 'brand_font',
      contentType: 'font/ttf',
      sizeBytes: 10,
      fileName: 'B.ttf',
      businessId: 'biz-1',
    };
    const noLicence = await createUpload(font);
    expect(noLicence.status).toBe(400);
    expect(JSON.stringify(noLicence.json)).toContain('licence');
    expect(
      (await createUpload({ ...base, kind: 'brand_logo', sizeBytes: 50 * 1024 * 1024 })).status,
    ).toBe(413);
    expect((await createUpload({ ...base, kind: 'brand_logo' }, 'reader')).status).toBe(403);
    const ok = await createUpload({ ...font, licenceConfirmed: true });
    expect(ok.status).toBe(201);
    expect(ok.json.upload).toMatchObject({ kind: 'brand_font', state: 'PENDING' });
    expect(String((ok.json.upload as { putUrl: string }).putUrl)).toContain(`orgs/${org}/brand/`);
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.upload.create' });
  });

  it('complete checks the bytes: logo needs transparency, fonts yield their family name', async () => {
    const opaque = await uploadBrand('brand_logo', 'image/png', await opaquePng());
    expect(opaque.completed.status).toBe(400);
    expect(JSON.stringify(opaque.completed.json)).toContain('transparency');
    const logo = await uploadBrand('brand_logo', 'image/png', await transparentPng());
    expect(logo.completed.status).toBe(200);
    expect(logo.completed.json.upload).toMatchObject({ state: 'READY', width: 300, height: 150 });
    const font = await uploadBrand('brand_font', 'font/ttf', fakeTtf('Brandon Grotesque'), {
      licenceConfirmed: true,
    });
    expect(font.completed.json.upload).toMatchObject({
      state: 'READY',
      fontFamily: 'Brandon Grotesque',
    });
    const notFont = await uploadBrand('brand_font', 'font/ttf', await opaquePng(), {
      licenceConfirmed: true,
    });
    expect(notFont.completed.status).toBe(400);
    const card = await uploadBrand('brand_card', 'video/mp4', new Uint8Array([0, 0, 0, 24]));
    expect(card.completed.json.upload).toMatchObject({ state: 'READY', durationSec: 4 });
    expect((await complete(logo.id, 'stranger')).status).toBe(404);
  });

  it('PATCH brand kit sets media, uploaded font and the AI label; wrong kinds are refused', async () => {
    const kit = (
      await call(brandKitsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { businessId: 'biz-1', name: 'Kit' },
      })
    ).json.brandKit as { id: string };
    const logo = await uploadBrand('brand_logo', 'image/png', await transparentPng());
    const mark = await uploadBrand('brand_watermark', 'image/png', await opaquePng());
    const font = await uploadBrand('brand_font', 'font/ttf', fakeTtf('Brandon'), {
      licenceConfirmed: true,
    });
    const patch = (body: unknown, token = 'owner') =>
      call(brandKitRoute.PATCH, { method: 'PATCH', token, body, params: { id: kit.id } });

    const res = await patch({
      logoAssetId: logo.id,
      watermarkAssetId: mark.id,
      fontPrimary: `upload:${font.id}`,
      aiDisclosureLabel: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.brandKit).toMatchObject({
      logoAssetId: logo.id,
      watermarkAssetId: mark.id,
      fontPrimary: `upload:${font.id}`,
      aiDisclosureLabel: true,
    });
    expect((await patch({ logoAssetId: mark.id })).status).toBe(400); // a watermark is not a logo
    expect((await patch({ introCardAssetId: 'missing' })).status).toBe(400);
    expect((await patch({ fontPrimary: 'upload:nope' })).status).toBe(400);
    expect((await patch({ logoAssetId: null })).json.brandKit).toMatchObject({ logoAssetId: null });
  });

  it('DELETE is a soft delete: hidden from list/get, row kept, default cleared', async () => {
    const kit = (
      await call(brandKitsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { businessId: 'biz-del', name: 'Gone' },
      })
    ).json.brandKit as { id: string };
    const del = await call(brandKitRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: kit.id },
    });
    expect(del.status).toBe(200);
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.brand_kit.delete',
      metadata: { softDelete: true },
    });
    expect((await call(brandKitRoute.GET, { token: 'owner', params: { id: kit.id } })).status).toBe(
      404,
    );
    const listed = await call(brandKitsRoute.GET, {
      token: 'owner',
      path: '/api/studio/brand-kits?businessId=biz-del',
    });
    expect(listed.json.data).toEqual([]);
    const row = await db.brandKit.findUniqueOrThrow({ where: { id: kit.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.isDefault).toBe(false);
    // The next kit of the business becomes its default again.
    const next = await call(brandKitsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { businessId: 'biz-del', name: 'New' },
    });
    expect((next.json.brandKit as { isDefault: boolean }).isDefault).toBe(true);
  });

  it('PATCH /projects/:id { renderOptions } stores presets and gates 4K to Plus', async () => {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz-1',
        createdByUserId: 'user-1',
        name: 'Presets',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', duration: 60 }],
      },
    });
    const patch = (body: unknown, token = 'owner') =>
      call(projectRoute.PATCH, { method: 'PATCH', token, body, params: { id: project.id } });
    const denied = await patch({ renderOptions: { youtubeResolution: '4k' } });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ error: 'plan_tier', message: '4K needs Plus' });
    expect((await patch({ renderOptions: { fps: 25 } })).status).toBe(400);
    const ok = await patch({ renderOptions: { fps: 60, youtubeResolution: '4k' } }, 'plus');
    expect(ok.status).toBe(200);
    const stored = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.renderOptions).toEqual({ fps: 60, youtubeResolution: '4k' });
    const both = await patch({ name: 'Renamed', renderOptions: { fps: null, draft: true } });
    expect(both.status).toBe(200);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.name).toBe('Renamed');
    expect(after.renderOptions).toEqual({ youtubeResolution: '4k', draft: true });
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.project.update',
      metadata: expect.objectContaining({ fields: ['name', 'renderOptions'] }),
    });
    expect((await patch({ renderOptions: { draft: false } }, 'stranger')).status).toBe(404);
  });
});
