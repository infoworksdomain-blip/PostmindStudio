import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as duplicateRoute from '../../src/app/api/studio/projects/[id]/duplicate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as demoVideosRoute from '../../src/app/api/studio/uploads/demo-videos/route';
import * as completeRoute from '../../src/app/api/studio/uploads/[id]/complete/route';
import * as uploadsRoute from '../../src/app/api/studio/uploads/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { readHookDemo } from '../../src/lib/studio/formats/hook-demo';
import { readWallOfText } from '../../src/lib/studio/formats/wall-of-text';
import type { MediaInspector, MediaProbe } from '../../src/lib/studio/pipeline/media-probe';
import { unsharedAssetObjects } from '../../src/lib/studio/services/business-hard-delete';
import type { UploadDeps } from '../../src/lib/studio/uploads/signer';
import { call, installApi, tenant } from '../helpers/api-harness';
import { memoryStorage } from '../helpers/memory-storage';

// BACKLOG 22.1 / 22.2 — POST /projects for HOOK_DEMO and WALL_OF_TEXT through the real route
// wrapper on real Postgres: the demo-video bank (demo_video uploads, GET /uploads/demo-videos),
// Fastlane's no_demo_video refusal, the stored format settings, fixed lengths, duplicates and
// retention keeping a demo object that the bank still owns.

const hasDb = Boolean(process.env.DATABASE_URL);

const PROBE: MediaProbe = {
  durationSec: 42,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  videoProfile: 'High',
  audioCodec: 'aac',
  formatName: 'mov,mp4',
  bitRateKbps: 4000,
};

describe.skipIf(!hasDb)(
  'hook + demo and wall-of-text projects (22.1 / 22.2)',
  { timeout: 60_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `fmt-api-${randomUUID()}`;
    const tokens = { owner: tenant(org), reader: tenant(org, ['studio:project:read']) };
    const businessId = 'biz-fmt';
    const tiktok = [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }];

    beforeEach(() => {
      const api = installApi(db, tokens);
      const mem = memoryStorage();
      const uploads: UploadDeps = {
        signer: {
          presignPut: vi.fn(async ({ key }) => `https://s3.test/${key}?X-Amz-Signature=x`),
        },
        media: { probe: vi.fn(async () => PROBE) } as unknown as MediaInspector,
        storage: mem.storage,
        bucket: 'assets',
      };
      api.deps.uploads = uploads;
    });

    afterAll(async () => {
      setApiDeps(undefined);
      await db.videoAsset.deleteMany({ where: { organisationId: org } });
      await db.videoUpload.deleteMany({ where: { organisationId: org } });
      await db.videoProject.deleteMany({ where: { organisationId: org } });
      await db.$disconnect();
    });

    const create = (body: Record<string, unknown>, token = 'owner') =>
      call(projectsRoute.POST, { method: 'POST', token, body: { businessId, ...body } });

    async function demoUpload(over: Record<string, unknown> = {}) {
      return db.videoUpload.create({
        data: {
          organisationId: org,
          businessId,
          createdByUserId: 'user-1',
          kind: 'DEMO_VIDEO',
          fileName: 'app-demo.mp4',
          contentType: 'video/mp4',
          declaredBytes: BigInt(1_000_000),
          s3Bucket: 'assets',
          s3Key: `orgs/${org}/uploads/${randomUUID()}/source.mp4`,
          state: 'READY',
          durationSec: 42,
          widthPx: 1080,
          heightPx: 1920,
          expiresAt: new Date(Date.now() + 3_600_000),
          completedAt: new Date(),
          ...over,
        },
      });
    }

    it('refuses a hook + demo video when the business has no demo video (no_demo_video)', async () => {
      const res = await create({ sourceType: 'HOOK_DEMO', targetFormats: tiktok });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({
        error: 'no_demo_video',
        details: { reason: 'no_demo_video' },
      });
      expect(await db.videoProject.count({ where: { organisationId: org } })).toBe(0);
    });

    it('a demo_video upload needs a business and completes into the bank', async () => {
      const missing = await call(uploadsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { kind: 'demo_video', contentType: 'video/mp4', sizeBytes: 1_000, fileName: 'd.mp4' },
      });
      expect(missing.status).toBe(400);
      const res = await call(uploadsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: {
          kind: 'demo_video',
          contentType: 'video/mp4',
          sizeBytes: 1_000,
          fileName: 'demo.mp4',
          businessId,
        },
      });
      expect(res.status).toBe(201);
      const upload = res.json.upload as { id: string; kind: string };
      expect(upload.kind).toBe('demo_video');
      const row = await db.videoUpload.findUniqueOrThrow({ where: { id: upload.id } });
      expect(row.kind).toBe('DEMO_VIDEO');
      // The PUT never happened here: /complete says so instead of probing nothing.
      const complete = await call(completeRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: upload.id },
      });
      expect(complete.status).toBe(400);
    });

    it('lists the business’s ready demo videos, newest first, for readers too', async () => {
      const older = await demoUpload({ completedAt: new Date(Date.now() - 60_000) });
      const newer = await demoUpload();
      await demoUpload({ state: 'PENDING', completedAt: null });
      await demoUpload({ businessId: 'other-biz' });
      const res = await call(demoVideosRoute.GET, {
        token: 'reader',
        path: `/api/studio/uploads/demo-videos?businessId=${businessId}`,
      });
      expect(res.status).toBe(200);
      const ids = (res.json.data as Array<{ id: string }>).map((u) => u.id);
      expect(ids.slice(0, 2)).toEqual([newer.id, older.id]);
      expect(ids).toHaveLength(2);
    });

    it('creates a hook + demo project on the newest demo, with its own asset and settings', async () => {
      const res = await create({
        sourceType: 'HOOK_DEMO',
        targetFormats: tiktok,
        hookDemo: { hookLine: 'Bookings in two taps', layout: 'stacked', audioMix: 'demo' },
      });
      expect(res.status).toBe(201);
      const project = res.json.project as {
        id: string;
        metadata: unknown;
        targetFormats: Array<{ duration: number }>;
        sourceRef: string;
      };
      const doc = readHookDemo(project.metadata as never);
      expect(doc).toMatchObject({
        hookLine: 'Bookings in two taps',
        hookSource: 'ai_creator',
        layout: 'stacked',
        audioMix: 'demo',
        targetSec: 15,
      });
      // The fixed length replaces the format's (30 s asked, 15 s target).
      expect(project.targetFormats[0]?.duration).toBe(15);
      expect(project.sourceRef).toBe(doc?.demoUploadId);
      const asset = await db.videoAsset.findUniqueOrThrow({ where: { id: doc?.demoAssetId } });
      expect(asset).toMatchObject({ projectId: project.id, kind: 'VIDEO_CLIP', durationSec: 42 });
      // The bank keeps the upload: it is never claimed by one project.
      const upload = await db.videoUpload.findUniqueOrThrow({ where: { id: doc?.demoUploadId } });
      expect(upload.projectId).toBeNull();

      // A copy uses the same demo through its own asset row.
      const copy = await call(duplicateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: project.id },
      });
      expect(copy.status).toBe(201);
      const copied = readHookDemo((copy.json.project as { metadata: unknown }).metadata as never);
      expect(copied?.demoUploadId).toBe(doc?.demoUploadId);
      expect(copied?.demoAssetId).not.toBe(doc?.demoAssetId);

      // Retention never deletes the bank's object with a deleted project's asset.
      expect(await unsharedAssetObjects(db, [project.id])).toEqual([]);
    });

    it('refuses a chosen demo that is not this business’s ready demo video', async () => {
      const other = await demoUpload({ businessId: 'other-biz' });
      const res = await create({
        sourceType: 'HOOK_DEMO',
        targetFormats: tiktok,
        hookDemo: { demoUploadId: other.id },
      });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({
        error: 'no_demo_video',
        details: { reason: 'demo_not_found' },
      });
    });

    it('validates the hook line (≤ 12 words) and the format-only fields', async () => {
      const long = await create({
        sourceType: 'HOOK_DEMO',
        targetFormats: tiktok,
        hookDemo: { hookLine: 'one two three four five six seven eight nine ten eleven twelve 13' },
      });
      expect(long.status).toBe(400);
      const misplaced = await create({
        brief: { rawInput: 'A video' },
        targetFormats: tiktok,
        hookDemo: {},
      });
      expect(misplaced.status).toBe(400);
    });

    it('creates a wall of text from the owner’s block (no brief needed) at its fixed length', async () => {
      const res = await create({
        sourceType: 'WALL_OF_TEXT',
        targetFormats: tiktok,
        wallOfText: {
          text: 'Three habits\n- Plan\n- Batch\n- Rest',
          background: 'nature',
          durationSec: 10,
        },
      });
      expect(res.status).toBe(201);
      const project = res.json.project as {
        metadata: unknown;
        targetFormats: Array<{ duration: number }>;
      };
      expect(readWallOfText(project.metadata as never)).toMatchObject({
        text: 'Three habits\n- Plan\n- Batch\n- Rest',
        background: 'nature',
        durationSec: 10,
      });
      expect(project.targetFormats[0]?.duration).toBe(10);
    });

    it('a wall of text needs a brief or a text block, at most 60 words and no emoji', async () => {
      expect((await create({ sourceType: 'WALL_OF_TEXT', targetFormats: tiktok })).status).toBe(
        400,
      );
      const emoji = await create({
        sourceType: 'WALL_OF_TEXT',
        targetFormats: tiktok,
        wallOfText: { text: 'Sale now 🔥' },
      });
      expect(emoji.status).toBe(400);
      const words = Array.from({ length: 61 }, (_, i) => `w${i}`).join(' ');
      const long = await create({
        sourceType: 'WALL_OF_TEXT',
        targetFormats: tiktok,
        wallOfText: { text: words },
      });
      expect(long.status).toBe(400);
      const briefOnly = await create({
        sourceType: 'WALL_OF_TEXT',
        targetFormats: tiktok,
        brief: { rawInput: 'Three ways to keep bread fresh' },
      });
      expect(briefOnly.status).toBe(201);
    });
  },
);
