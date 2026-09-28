import type { PrismaClient } from '@prisma/client';

// P7 test data: one business with a Runway project (5 clips, approved by a person, published at
// 70 % retention) and a Luma project (5 clips rejected, 3 then swapped for uploads).

const MIN = 60_000;

async function seedProject(
  db: PrismaClient,
  input: {
    organisationId: string;
    businessId: string;
    provider: string;
    base: Date;
    verdict: 'APPROVED' | 'REJECTED';
    replaced: number;
    retention?: number;
  },
): Promise<string> {
  const t = (min: number) => new Date(input.base.getTime() + min * MIN);
  const project = await db.videoProject.create({
    data: {
      organisationId: input.organisationId,
      businessId: input.businessId,
      createdByUserId: 'user-1',
      name: `${input.provider} ratings`,
      state: input.verdict === 'APPROVED' ? 'PUBLISHED' : 'REJECTED',
      sourceType: 'BRIEF',
      targetFormats: [{ platform: 'youtube', aspectRatio: '9:16', duration: 25 }],
    },
  });
  const script = await db.videoScript.create({
    data: {
      projectId: project.id,
      targetPlatform: 'youtube',
      targetAspectRatio: '9:16',
      targetDurationSec: 25,
      fullText: 'text',
      scriptModel: 'test',
    },
  });
  for (let i = 0; i < 5; i += 1) {
    const shot = await db.videoShot.create({
      data: {
        scriptId: script.id,
        sortOrder: i,
        durationSec: 5,
        visualTreatment: 'AI_CLIP',
        sceneDescription: 'scene',
        state: 'READY',
      },
    });
    const asset = (source: string, createdAt: Date) => ({
      organisationId: input.organisationId,
      projectId: project.id,
      shotId: shot.id,
      kind: 'VIDEO_CLIP' as const,
      source,
      s3Bucket: 'assets',
      s3Key: `${shot.id}/${source}.mp4`,
      createdAt,
    });
    await db.videoAsset.create({ data: asset(`${input.provider}:model`, t(0)) });
    if (i < input.replaced) await db.videoAsset.create({ data: asset('upload:clip', t(10)) });
  }
  await db.approvalTask.create({
    data: {
      projectId: project.id,
      stepIndex: 0,
      requiredRole: 'reviewer',
      state: input.verdict,
      resolvedByUserId: 'user-1',
      resolvedAt: t(5),
    },
  });
  // A system auto-approval is not a person's rating and is ignored.
  await db.approvalTask.create({
    data: {
      projectId: project.id,
      stepIndex: 0,
      requiredRole: 'reviewer',
      state: 'APPROVED',
      resolvedByUserId: 'system:auto-approve',
      resolvedAt: t(1),
    },
  });
  if (input.retention !== undefined) {
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: script.id,
        targetPlatform: 'youtube',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 25,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `${project.id}.mp4`,
        qualityCheckState: 'PASSED',
        createdAt: t(2),
      },
    });
    const pub = await db.videoPublication.create({
      data: {
        organisationId: input.organisationId,
        projectId: project.id,
        renderId: render.id,
        platform: 'youtube',
        platformAccountId: 'chan',
        state: 'PUBLISHED',
        publishedAt: t(30),
      },
    });
    await db.videoAnalytic.create({
      data: {
        publicationId: pub.id,
        bucketAt: t(60),
        bucketSize: 'day',
        views: 100,
        avgWatchTimePct: input.retention,
      },
    });
  }
  return project.id;
}

export async function seedProviderRatings(
  db: PrismaClient,
  input: { organisationId: string; businessId: string; now: number },
): Promise<{ projectIds: string[]; cleanup: () => Promise<void> }> {
  const base = new Date(input.now - 2 * 86_400_000);
  const common = { organisationId: input.organisationId, businessId: input.businessId, base };
  const projectIds = [
    await seedProject(db, {
      ...common,
      provider: 'runway',
      verdict: 'APPROVED',
      replaced: 0,
      retention: 0.7,
    }),
    await seedProject(db, { ...common, provider: 'luma', verdict: 'REJECTED', replaced: 3 }),
  ];
  const cleanup = async () => {
    const where = { projectId: { in: projectIds } };
    const pubs = await db.videoPublication.findMany({ where, select: { id: true } });
    await db.videoAnalytic.deleteMany({ where: { publicationId: { in: pubs.map((p) => p.id) } } });
    await db.videoPublication.deleteMany({ where });
    await db.videoRender.deleteMany({ where });
    await db.approvalTask.deleteMany({ where });
    await db.videoAsset.deleteMany({ where });
    await db.videoShot.deleteMany({ where: { script: where } });
    await db.videoScript.deleteMany({ where });
    await db.videoProject.deleteMany({ where: { id: { in: projectIds } } });
  };
  return { projectIds, cleanup };
}
