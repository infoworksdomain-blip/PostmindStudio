import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as captionsRoute from '../../src/app/api/studio/renders/[id]/captions/route';
import * as renderRoute from '../../src/app/api/studio/renders/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call } from '../helpers/api-harness';
import {
  approve,
  briefBody,
  cleanupGolden,
  connect,
  createProject,
  drain,
  generate,
  getPublication,
  publish,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Phase 15 Track A golden journeys (real pipeline, Postgres, recording publishers):
//   META-03  brief with an Instagram feed (4:5) format → generate → approve → publish to a
//            Core-registered Instagram account (REELS container shared to the feed, AI label on);
//            and a Facebook feed video (16:9) through the Page connection.
//   CR-04    narration is captioned: burned-in caption overlays (sortOrder ≥ 50) on the feed
//            render's shots, a generated thumbnail per render, and the YouTube long-form render
//            gets an SRT in the project language that goes up with the video (captions.insert),
//            together with the custom thumbnail (thumbnails.set).
//   GP-16    SCHEDULED project with scheduledStartAt → approval schedules every target,
//            staggered 30 minutes apart (spec 9.9), through the outbox.

const hasDb = Boolean(process.env.DATABASE_URL);
const PORTRAIT_45 = { width: 1080, height: 1350 };
const LANDSCAPE = { width: 1920, height: 1080 };

async function captionRows(j: Journey, projectId: string, platform: string) {
  const scripts = await j.db.videoScript.findMany({
    where: { projectId, targetPlatform: platform },
    include: { shots: { include: { overlays: true } } },
  });
  return scripts
    .flatMap((s) => s.shots.flatMap((shot) => shot.overlays))
    .filter((o) => o.sortOrder >= 50);
}

/** The API reads thumbnails from the same bucket the worker writes (S3_BUCKET_THUMBNAILS). */
function journey(db: PrismaClient, id: string, probe: { width: number; height: number }) {
  const j = startJourney(db, id, { probe });
  j.api.deps.thumbnails = {
    bucket: 'thumbnails',
    composer: { compose: async () => new Uint8Array([0xff, 0xd8, 0xff]) },
  };
  return j;
}

async function expectThumbnails(renders: Array<{ id: string }>) {
  for (const r of renders) {
    const got = await call(renderRoute.GET, { token: 'reader', params: { id: r.id } });
    expect((got.json.render as { thumbnailUrl: string | null }).thumbnailUrl).toBeTruthy();
  }
}

describe.skipIf(!hasDb)(
  'golden journeys: Phase 15 publishing (Track A)',
  { timeout: 180_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();

    afterAll(async () => {
      setApiDeps(undefined);
      await db.autoPublishOutbox.deleteMany({
        where: { organisationId: { startsWith: 'golden-' } },
      });
      await cleanupGolden(db, since);
      await db.$disconnect();
    });

    it('META-03 + CR-04: Instagram feed with burned-in captions and a thumbnail', async () => {
      const j = journey(db, 'p15a-igfeed', PORTRAIT_45);
      const id = await createProject(
        j,
        briefBody({
          targetFormats: [{ platform: 'instagram_feed', aspectRatio: '4:5', durationSec: 15 }],
        }),
      );
      expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
      const renders = await rendersOf(j, id);
      expect(renders.map((r) => r.targetPlatform)).toEqual(['instagram_feed']);
      const captions = await captionRows(j, id, 'instagram_feed');
      expect(captions.length).toBeGreaterThan(0);
      expect(captions[0]).toMatchObject({ anchorY: 0.7, lang: 'en-GB' });
      await expectThumbnails(renders);

      await approve(j, id);
      const ig = await connect(j, 'instagram');
      const pub = await publish(j, {
        renderId: renders[0]?.id,
        platform: 'instagram_feed',
        platformAccountId: ig.platformAccountId,
        caption: 'Fresh every Friday',
        hashtags: ['sourdough'],
      });
      await drain(j);
      expect((await getPublication(j, pub)).state).toBe('PUBLISHED');
      expect(j.h.publishers.instagram_feed.published[0]?.aiGenerated).toBe(true);
      expect(j.h.publishers.instagram_feed.published[0]?.video.aspectRatio).toBe('4:5');
    });

    it('META-03 + CR-04: Facebook feed and YouTube long-form (SRT + thumbnail uploaded)', async () => {
      const j = journey(db, 'p15a-fbyt', LANDSCAPE);
      const id = await createProject(
        j,
        briefBody({
          targetFormats: [
            { platform: 'facebook_feed', aspectRatio: '16:9', durationSec: 15 },
            { platform: 'youtube', aspectRatio: '16:9', durationSec: 15 },
          ],
        }),
      );
      expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
      const renders = await rendersOf(j, id);
      expect((await captionRows(j, id, 'facebook_feed')).length).toBeGreaterThan(0);
      expect(await captionRows(j, id, 'youtube')).toHaveLength(0);
      await expectThumbnails(renders);
      const youtube = renders.find((r) => r.targetPlatform === 'youtube');
      const caps = await call(captionsRoute.GET, {
        token: 'reader',
        params: { id: youtube?.id ?? '' },
      });
      expect(caps.json).toMatchObject({ mode: 'srt', language: 'en-GB' });
      expect((caps.json.lines as unknown[]).length).toBeGreaterThan(0);

      await approve(j, id);
      const fb = await connect(j, 'facebook');
      const yt = await connect(j, 'youtube');
      const pick = (p: string) => renders.find((r) => r.targetPlatform === p)?.id;
      const fbPub = await publish(j, {
        renderId: pick('facebook_feed'),
        platform: 'facebook_feed',
        connectionId: fb.id,
        caption: 'Fresh every Friday',
      });
      const ytPub = await publish(j, {
        renderId: pick('youtube'),
        platform: 'youtube',
        connectionId: yt.id,
        caption: 'Fresh every Friday',
        title: 'Leeds sourdough',
      });
      await drain(j);
      expect((await getPublication(j, fbPub)).state).toBe('PUBLISHED');
      expect((await getPublication(j, ytPub)).state).toBe('PUBLISHED');
      expect(j.h.publishers.facebook_feed.published[0]?.video.aspectRatio).toBe('16:9');
      const ytReq = j.h.publishers.youtube.published[0];
      expect(ytReq?.thumbnail?.contentType).toBe('image/jpeg');
      expect(ytReq?.captions).toMatchObject({ language: 'en-GB', name: 'Studio narration' });
      expect(ytReq?.captions?.srt).toMatch(/^1\n00:00:0/);
    });

    it('GP-16: an approved SCHEDULED project posts each target on a 30-minute stagger', async () => {
      const j = startJourney(db, 'p15a-sched');
      const tt = await connect(j, 'tiktok');
      const yt = await connect(j, 'youtube');
      const start = new Date(Date.now() + 3 * 86_400_000);
      const id = await createProject(
        j,
        briefBody({
          targetFormats: [
            { platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 },
            { platform: 'youtube_short', aspectRatio: '9:16', durationSec: 15 },
          ],
          publishPolicy: 'SCHEDULED',
          scheduledStartAt: start.toISOString(),
          autoPublish: {
            targets: [
              { platform: 'tiktok', connectionId: tt.id, caption: 'Friday!' },
              { platform: 'youtube_short', connectionId: yt.id, caption: 'Friday!' },
            ],
          },
        }),
      );
      expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
      const res = await call(approveRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
        body: {},
      });
      expect(res.status).toBe(200);
      const scheduled = res.json.scheduled as Array<{ platform: string; scheduledFor: string }>;
      expect(
        scheduled.map((s) => [s.platform, Date.parse(s.scheduledFor) - start.getTime()]),
      ).toEqual([
        ['tiktok', 0],
        ['youtube_short', 30 * 60_000],
      ]);
      const pubs = await db.videoPublication.findMany({ where: { projectId: id } });
      const rows = await db.scheduledPublication.findMany({
        where: { publicationId: { in: pubs.map((p) => p.id) } },
      });
      expect(rows.map((r) => r.state)).toEqual(['PENDING', 'PENDING']);
    });
  },
);
