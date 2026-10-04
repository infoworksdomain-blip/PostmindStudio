import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { rebalanceNarration } from '../../src/lib/studio/pipeline/narration-rebalance';
import { fitOf } from '../../src/lib/studio/pipeline/voice-fit';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// 21.1 on real Postgres: a trimmed line gets time from another shot, inside one transaction, and
// the shot lengths the captions/EDL read are the rebalanced ones.

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = 'rebalance-';

describe.skipIf(!hasDb)('narration rebalance on real Postgres', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  afterAll(async () => {
    const projects = await db.videoProject.findMany({
      where: { organisationId: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = projects.map((p) => p.id);
    await db.textOverlay.deleteMany({ where: { shot: { script: { projectId: { in: ids } } } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { projectId: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.providerUsage.deleteMany({ where: { organisationId: { startsWith: PREFIX } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it('lengthens the trimmed shot, takes the time from another, and is idempotent', async () => {
    const organisationId = `${PREFIX}${randomUUID()}`;
    const h = createHarness(db);
    const { project, runId } = await createProject(db, { organisationId });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    await drainInline(h.queue, h.deps);

    const shots = await db.videoShot.findMany({
      where: { script: { projectId: project.id } },
      orderBy: { sortOrder: 'asc' },
    });
    const card = shots.at(-1);
    expect(card?.voiceAssetId).toBeTruthy();
    // The script's length once the card is shortened to 1.5 s below.
    const total = shots.reduce((sum, s) => sum + s.durationSec, 0) - card!.durationSec + 1.5;
    // Make the end card's narration overrun its (shortened) card, as voice fit would record it.
    await db.videoShot.update({ where: { id: card!.id }, data: { durationSec: 1.5 } });
    const voice = await db.videoAsset.findUniqueOrThrow({ where: { id: card!.voiceAssetId! } });
    await db.videoAsset.update({
      where: { id: voice.id },
      data: {
        metadata: {
          ...((voice.metadata as Record<string, unknown> | null) ?? {}),
          fit: { strategy: 'trim', voiceSec: 2, shotSec: 1.5, trimSec: 1.2, wordBoundary: true },
        } as Prisma.InputJsonValue,
      },
    });
    // No head-room: the time must come from the other shots.
    await db.videoScript.updateMany({
      where: { projectId: project.id },
      data: { targetDurationSec: total - 1.5 },
    });

    const first = await rebalanceNarration(h.deps, {
      projectId: project.id,
      organisationId,
      runId,
    });
    expect(first).toEqual({ lengthened: 1, shortened: [] });
    const after = await db.videoShot.findMany({
      where: { script: { projectId: project.id } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(after.at(-1)?.durationSec).toBe(2.2);
    const totalAfter = after.reduce((sum, s) => sum + s.durationSec, 0);
    expect(totalAfter).toBeCloseTo(total, 3); // unchanged by the rebalance
    const rebalanced = await db.videoAsset.findUniqueOrThrow({ where: { id: voice.id } });
    expect(fitOf(rebalanced.metadata)).toMatchObject({ strategy: 'rebalance', newShotSec: 2.2 });
    expect(fitOf(rebalanced.metadata)?.trimSec).toBeUndefined();
    const meta = (await db.videoProject.findUniqueOrThrow({ where: { id: project.id } }))
      .metadata as Record<string, unknown>;
    expect(meta.narrationShortened).toEqual([]);

    // A retried compose finds nothing left to do.
    const again = await rebalanceNarration(h.deps, {
      projectId: project.id,
      organisationId,
      runId,
    });
    expect(again).toEqual({ lengthened: 0, shortened: [] });
  });
});
