import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as brandKitRoute from '../../src/app/api/studio/brand-kits/[id]/route';
import * as brandKitsRoute from '../../src/app/api/studio/brand-kits/route';
import * as rerenderRoute from '../../src/app/api/studio/renders/[id]/rerender/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { parseCompositionSummary } from '../../src/lib/studio/pipeline/composition-summary';
import { call } from '../helpers/api-harness';
import { SCRIPT_JSON } from '../helpers/pipeline-harness';
import {
  BUSINESS_ID,
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  generate,
  ORG_PREFIX,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Phase 15 Track B journeys, through the real routes and workers:
//   QF-02  Brand kit with logo + watermark → the edit carries them → the watermark frame sample
//          fails closed (QUALITY_FAILED: watermark) → a render that shows it → re-render passes;
//          the composition cache re-points to the same render (no second Shotstack call).
//   CR-05  Cost regression (15.B6): a second project with the same script reuses every clip and
//          narration (zero-cost reused provider jobs), so its spend is far lower.
//   MG-01  MOTION_GRAPHICS shot (15.B8) → no provider call, shape + text clips on the timeline;
//          IMAGE_STILL (15.B5) → generated once, kept in the library, found by the next project.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Clip = { asset: Record<string, unknown> } & Record<string, unknown>;
type Edit = { timeline: { tracks: Array<{ clips: Clip[] }>; fonts?: Array<{ src: string }> } };
const lastEdit = (j: Journey) =>
  (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
const clipsOf = (edit: Edit) => edit.timeline.tracks.flatMap((t) => t.clips);

async function brandUpload(
  j: Journey,
  kind: 'BRAND_LOGO' | 'BRAND_WATERMARK',
  bytes: Uint8Array,
  size: { width: number; height: number },
) {
  const key = `orgs/${j.org}/brand/${kind}-${Date.now()}.png`;
  await j.h.deps.storage.put({ bucket: 'assets', key, body: bytes, contentType: 'image/png' });
  return j.db.videoUpload.create({
    data: {
      organisationId: j.org,
      businessId: BUSINESS_ID,
      createdByUserId: 'user-1',
      kind,
      fileName: 'mark.png',
      contentType: 'image/png',
      declaredBytes: BigInt(bytes.byteLength),
      s3Bucket: 'assets',
      s3Key: key,
      state: 'READY',
      widthPx: size.width,
      heightPx: size.height,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}

async function checkerboard(size: number): Promise<Uint8Array> {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const on = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0;
      px.set(on ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * size + x) * 4);
    }
  return new Uint8Array(
    await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

describe.skipIf(!hasDb)(
  'golden journeys: Phase 15 composition (Track B)',
  { timeout: 180_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();

    beforeAll(async () => {
      await db.$connect();
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setApiDeps(undefined);
      await db.videoUpload.deleteMany({ where: { organisationId: { startsWith: ORG_PREFIX } } });
      await db.imageLibraryItem.deleteMany({
        where: { organisationId: { startsWith: ORG_PREFIX } },
      });
      await cleanupGolden(db, since);
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    it('QF-02 brand logo + watermark on the timeline; watermark check fails closed, then passes', async () => {
      const j = startJourney(db, 'qf02');
      const logoPng = new Uint8Array(
        await sharp({
          create: {
            width: 200,
            height: 100,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png()
          .toBuffer(),
      );
      const markPng = await checkerboard(128);
      const logo = await brandUpload(j, 'BRAND_LOGO', logoPng, { width: 200, height: 100 });
      const mark = await brandUpload(j, 'BRAND_WATERMARK', markPng, { width: 128, height: 128 });
      const kit = (
        await call(brandKitsRoute.POST, {
          method: 'POST',
          token: 'owner',
          body: {
            businessId: BUSINESS_ID,
            name: 'Golden kit',
            colourPalette: ['#112233', '#FFFFFF'],
          },
        })
      ).json.brandKit as { id: string };
      const patched = await call(brandKitRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id: kit.id },
        body: { logoAssetId: logo.id, watermarkAssetId: mark.id },
      });
      expect(patched.status).toBe(200);

      const id = await createProject(j, briefBody({ brandKitId: kit.id }));
      const failed = await generate(j, id);
      expect(failed.state).toBe('QUALITY_FAILED');
      const edit = lastEdit(j);
      expect(clipsOf(edit).some((c) => String(c.asset.src).includes('BRAND_LOGO'))).toBe(true);
      expect(clipsOf(edit).some((c) => String(c.asset.src).includes('BRAND_WATERMARK'))).toBe(true);
      const [render] = await rendersOf(j, id);
      const row = await db.videoRender.findUniqueOrThrow({ where: { id: render?.id ?? '' } });
      const checks = row.qualityIssues as Array<{ code: string; status: string; detail: string }>;
      expect(checks.find((c) => c.code === 'watermark')).toMatchObject({ status: 'failed' });
      expect(checks.find((c) => c.code === 'brand_kit')).toMatchObject({ status: 'passed' });
      expect(checks.find((c) => c.code === 'audio_sync')?.status).toBe('passed');

      // A render that does show the watermark at its rect: the frame sample now passes.
      const summary = parseCompositionSummary(row.composition);
      const rect = summary?.brand.watermark?.rect;
      expect(rect).toBeDefined();
      const noise = Buffer.alloc(1080 * 1920 * 3);
      for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7919) % 251;
      const withMark = await sharp(noise, { raw: { width: 1080, height: 1920, channels: 3 } })
        .composite([
          {
            input: await sharp(markPng).resize(rect?.width, rect?.height).png().toBuffer(),
            left: rect?.x ?? 0,
            top: rect?.y ?? 0,
          },
        ])
        .jpeg()
        .toBuffer();
      j.h.deps.media.frameJpeg = async () => new Uint8Array(withMark);

      const composerCalls = j.h.adapters.shotstack.requests.length;
      const rerender = await call(rerenderRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: render?.id ?? '' },
      });
      expect(rerender.status).toBe(202);
      await drain(j);
      const again = await db.videoProject.findUniqueOrThrow({ where: { id } });
      expect(again.state).toBe('READY_FOR_REVIEW');
      // 15.B6: identical edit → same render, no second Shotstack call.
      expect(j.h.adapters.shotstack.requests.length).toBe(composerCalls);
      expect(await rendersOf(j, id)).toHaveLength(1);
      expect((again.metadata as { compositionCache: unknown[] }).compositionCache).toHaveLength(1);
    });

    it('CR-05 a second project with the same script reuses clips and narration at zero cost', async () => {
      const j = startJourney(db, 'cr05');
      const first = await createProject(j);
      expect((await generate(j, first)).state).toBe('READY_FOR_REVIEW');
      const runwayCalls = j.h.adapters.runway.requests.length;
      const voiceCalls = j.h.adapters.elevenlabs.requests.length;
      expect(runwayCalls).toBe(2);

      // The scripted ElevenLabs double reports S3 keys without writing the files; store them so
      // the narration counts as still held (reuse checks the object exists).
      for (const a of await db.videoAsset.findMany({
        where: { projectId: first, kind: 'AUDIO_VOICE' },
      }))
        await j.h.deps.storage.put({
          bucket: a.s3Bucket,
          key: a.s3Key,
          body: new Uint8Array([1]),
          contentType: 'audio/mpeg',
        });
      const second = await createProject(j, briefBody({ name: 'Same again' }));
      expect((await generate(j, second)).state).toBe('READY_FOR_REVIEW');
      expect(j.h.adapters.runway.requests.length).toBe(runwayCalls); // no new clips
      expect(j.h.adapters.elevenlabs.requests.length).toBe(voiceCalls); // no new narration
      const reused = await db.providerJob.findMany({
        where: { projectId: second, operation: { endsWith: ':reused' } },
      });
      expect(reused.length).toBe(5); // 2 clips + 3 narrations
      expect(reused.every((r) => r.costPence === 0)).toBe(true);
      const spend = async (projectId: string) =>
        (
          await db.providerJob.aggregate({
            where: { projectId, operation: { in: ['text_to_video', 'tts'] } },
            _sum: { costPence: true },
          })
        )._sum.costPence ?? 0;
      expect(await spend(first)).toBeGreaterThan(0);
      expect(await spend(second)).toBe(0);
    });

    it('MG-01 motion-graphics shot without a provider call; stills come from the library', async () => {
      const script = {
        ...SCRIPT_JSON,
        shots: [
          {
            ...SCRIPT_JSON.shots[0],
            visualTreatment: 'IMAGE_STILL',
            sceneDescription: 'Golden sourdough loaf on a rustic counter',
          },
          {
            ...SCRIPT_JSON.shots[1],
            visualTreatment: 'MOTION_GRAPHICS',
            onScreenText: '3 loaves for £10',
          },
          SCRIPT_JSON.shots[2],
        ],
      };
      const j = startJourney(db, 'mg01', { script });
      const first = await createProject(j, briefBody({ costBudgetPence: 10_000 }));
      const done = await generate(j, first);
      if (done.state !== 'READY_FOR_REVIEW') {
        const r = await db.videoRender.findFirst({ where: { projectId: first } });
        throw new Error(`MG-01 ${done.state}: ${JSON.stringify(r?.qualityIssues)}`);
      }
      const images = () =>
        j.h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image').length;
      expect(images()).toBe(1);
      const shapes = clipsOf(lastEdit(j)).filter((c) => c.asset.type === 'shape');
      expect(shapes.length).toBe(2); // background + accent bar
      expect(clipsOf(lastEdit(j)).some((c) => c.asset.html === '<p>3 loaves for £10</p>')).toBe(
        true,
      );
      const kept = await db.imageLibraryItem.findMany({
        where: { organisationId: j.org, source: 'GENERATED' },
      });
      expect(kept).toHaveLength(1);

      // Different camera direction → a new prompt (no fingerprint reuse), same scene → library hit.
      const next = startJourney(db, 'mg01', {
        script: {
          ...script,
          shots: [{ ...script.shots[0], cameraDirection: 'overhead' }, ...script.shots.slice(1)],
        },
      });
      const second = await createProject(next, briefBody({ costBudgetPence: 10_000 }));
      expect((await generate(next, second)).state).toBe('READY_FOR_REVIEW');
      expect(
        next.h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image'),
      ).toHaveLength(0);
      const shot = await db.videoShot.findFirstOrThrow({
        where: { script: { projectId: second }, visualTreatment: 'IMAGE_STILL' },
      });
      const asset = await db.videoAsset.findUniqueOrThrow({ where: { id: shot.assetId ?? '' } });
      expect(asset.source).toBe(`image-library:${kept[0]?.id}`);
    });
  },
);
