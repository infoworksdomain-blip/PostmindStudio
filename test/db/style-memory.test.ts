import { randomUUID } from 'node:crypto';
import { PrismaClient, type VisualTreatment } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { buildStyleMemoryJob } from '../../src/lib/studio/queue/workers/build-style-memory';
import {
  buildStyleMemories,
  deleteStyleMemory,
  listStyleMemory,
  rebuildBusiness,
  styleMemorySupplement,
} from '../../src/lib/studio/services/style-memory';

// BACKLOG 13.29 on real Postgres: the nightly build from approvals, rejections, regenerations
// and YouTube retention; the transparency API (list with reasons, delete); and deletion
// tombstones that only relearn from newer evidence.

const hasDb = Boolean(process.env.DATABASE_URL);
const ORG = `style-${randomUUID().slice(0, 8)}`;
const BIZ = 'biz-style';
const DAY = 86_400_000;
const NOW = Date.now();

describe.skipIf(!hasDb)('style memory on real Postgres', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  async function makeProject(
    state: 'PUBLISHED' | 'REJECTED' | 'APPROVED',
    shots: Array<[number, VisualTreatment, string | null]>,
    publish?: { views: number; avgWatchTimePct: number; hourUtc: number },
  ) {
    const project = await db.videoProject.create({
      data: {
        organisationId: ORG,
        businessId: BIZ,
        createdByUserId: 'u',
        name: 'p',
        state,
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'youtube_short',
        targetAspectRatio: '9:16',
        targetDurationSec: 15,
        fullText: 'x',
        scriptModel: 'm',
      },
    });
    for (const [i, [durationSec, visualTreatment, provider]] of shots.entries()) {
      const shot = await db.videoShot.create({
        data: {
          scriptId: script.id,
          sortOrder: i,
          durationSec,
          visualTreatment,
          sceneDescription: 's',
          state: 'READY',
        },
      });
      if (provider) {
        const asset = await db.videoAsset.create({
          data: {
            organisationId: ORG,
            projectId: project.id,
            shotId: shot.id,
            kind: 'VIDEO_CLIP',
            source: `${provider}:model`,
            s3Bucket: 'a',
            s3Key: 'k',
          },
        });
        await db.videoShot.update({ where: { id: shot.id }, data: { assetId: asset.id } });
      }
    }
    if (publish) {
      const render = await db.videoRender.create({
        data: {
          projectId: project.id,
          scriptId: script.id,
          targetPlatform: 'youtube_short',
          aspectRatio: '9:16',
          resolution: '1080x1920',
          durationSec: 15,
          fps: 30,
          bitrateKbps: 1,
          s3Bucket: 'r',
          s3Key: 'k',
          qualityCheckState: 'PASSED',
        },
      });
      const publishedAt = new Date(NOW - 2 * DAY);
      publishedAt.setUTCHours(publish.hourUtc, 0, 0, 0);
      const pub = await db.videoPublication.create({
        data: {
          organisationId: ORG,
          projectId: project.id,
          renderId: render.id,
          platform: 'youtube_short',
          platformAccountId: 'chan',
          state: 'PUBLISHED',
          publishedAt,
        },
      });
      await db.videoAnalytic.create({
        data: {
          publicationId: pub.id,
          bucketAt: new Date(NOW - DAY),
          bucketSize: 'day',
          views: publish.views,
          avgWatchTimePct: publish.avgWatchTimePct,
        },
      });
    }
    return project;
  }

  beforeAll(async () => {
    await makeProject(
      'PUBLISHED',
      [
        [1.2, 'AI_CLIP', 'runway'],
        [3, 'IMAGE_STILL', 'openai'],
      ],
      { views: 900, avgWatchTimePct: 0.72, hourUtc: 7 },
    );
    await makeProject(
      'PUBLISHED',
      [
        [1.4, 'AI_CLIP', 'runway'],
        [3.5, 'AI_CLIP', 'runway'],
      ],
      { views: 700, avgWatchTimePct: 0.65, hourUtc: 8 },
    );
    const third = await makeProject('APPROVED', [
      [2, 'AI_CLIP', 'runway'],
      [4, 'TEXT_CARD', null],
    ]);
    // A regeneration: an earlier Luma asset of the same shot that was replaced.
    const shot = await db.videoShot.findFirstOrThrow({
      where: { script: { projectId: third.id }, sortOrder: 0 },
    });
    await db.videoAsset.create({
      data: {
        organisationId: ORG,
        projectId: third.id,
        shotId: shot.id,
        kind: 'VIDEO_CLIP',
        source: 'luma:ray2',
        s3Bucket: 'a',
        s3Key: 'old',
      },
    });
    await makeProject('REJECTED', [[8, 'AI_CLIP', 'luma']], {
      views: 50,
      avgWatchTimePct: 0.1,
      hourUtc: 22,
    });
  });

  afterAll(async () => {
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: ORG }, select: { id: true } })
    ).map((p) => p.id);
    const pubs = await db.videoPublication.findMany({
      where: { projectId: { in: ids } },
      select: { id: true },
    });
    await db.videoAnalytic.deleteMany({ where: { publicationId: { in: pubs.map((p) => p.id) } } });
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { organisationId: ORG } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.styleMemory.deleteMany({ where: { organisationId: ORG } });
    await db.$disconnect();
  });

  it('learns all five signals with reasons', async () => {
    const result = await rebuildBusiness(db, ORG, BIZ, NOW);
    expect(result.upserted).toBe(5);
    const list = await listStyleMemory(db, ORG, BIZ);
    const byType = Object.fromEntries(list.map((m) => [m.signalType, m]));
    expect(Object.keys(byType).sort()).toEqual([
      'posting_time',
      'provider_preference',
      'script_structure',
      'shot_pace',
      'treatment_mix',
    ]);
    expect(byType.shot_pace?.reason).toContain('3 approved videos');
    expect(byType.shot_pace?.reason).toContain('1 rejected video averaged 8 s');
    expect(byType.provider_preference?.value).toBe('runway shots are kept most often');
    expect(byType.provider_preference?.reason).toContain('1 luma shot regenerated');
    expect(byType.script_structure?.value).toBe('hook in the first 1.3 s, about 2 shots');
    // Median hour of the three most-viewed (07, 08, 22 UTC).
    expect(byType.posting_time?.value).toContain('08:00');
    const prompt = await styleMemorySupplement(db, ORG, BIZ);
    expect(prompt).toContain('<style_memory>');
    expect(prompt).toContain('- script structure: hook in the first 1.3 s');
  });

  it('keeps a deleted memory deleted until newer evidence arrives, then says so', async () => {
    const list = await listStyleMemory(db, ORG, BIZ);
    const pace = list.find((m) => m.signalType === 'shot_pace');
    await deleteStyleMemory(db, ORG, BIZ, pace?.id ?? '', Date.now());
    await rebuildBusiness(db, ORG, BIZ, Date.now() + 1_000);
    expect((await listStyleMemory(db, ORG, BIZ)).map((m) => m.signalType)).not.toContain(
      'shot_pace',
    );
    // Three new approvals after the deletion.
    for (let i = 0; i < 3; i++) {
      await makeProject('APPROVED', [
        [2, 'AI_CLIP', 'runway'],
        [2, 'AI_CLIP', 'runway'],
      ]);
    }
    await rebuildBusiness(db, ORG, BIZ, Date.now() + 1_000);
    const relearned = (await listStyleMemory(db, ORG, BIZ)).find(
      (m) => m.signalType === 'shot_pace',
    );
    expect(relearned?.reason).toContain('Learned again from videos made after you deleted');
    expect(relearned?.evidenceCount).toBe(3);
  });

  it('forgets memories whose evidence left the 90-day window and purges old tombstones', async () => {
    await db.styleMemory.create({
      data: {
        organisationId: ORG,
        businessId: 'biz-gone',
        signalType: 'POSTING_TIME',
        value: {},
        reason: 'Deleted by the user',
        deletedAt: new Date(NOW - 200 * DAY),
      },
    });
    await db.styleMemory.create({
      data: {
        organisationId: ORG,
        businessId: 'biz-gone',
        signalType: 'SHOT_PACE',
        value: { summary: 'stale' },
        reason: 'old',
      },
    });
    const result = await buildStyleMemories(db, NOW);
    expect(result.businesses).toBeGreaterThanOrEqual(2);
    expect(
      await db.styleMemory.count({ where: { organisationId: ORG, businessId: 'biz-gone' } }),
    ).toBe(0);
  });

  it('runs as the nightly job', async () => {
    const logs: unknown[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => logs.push(JSON.parse(line)) },
    );
    await buildStyleMemoryJob(
      { organisationId: 'postmind-platform', runId: 'style-memory', planTier: 'STANDARD' },
      { db, logger, now: () => NOW } as unknown as PipelineDeps,
    );
    expect(logs.at(-1)).toMatchObject({ msg: 'style memory rebuilt', runId: 'style-memory' });
  });
});
