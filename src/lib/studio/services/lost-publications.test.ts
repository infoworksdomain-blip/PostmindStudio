import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../audit';
import { ConfigurationError } from '../../errors';
import type { KillSwitchScope, KillSwitchStatus } from '../kill-switch';
import { InlineJobQueue, jobIds } from '../queue/enqueue';
import {
  lostPublishMarginMs,
  redriveJobId,
  redriveLostPublications,
  REDRIVE_ACTOR,
} from './lost-publications';

// BACKLOG 17.2 — SCHEDULED publications whose publish job was lost (commit, then crash before
// the enqueue) are re-enqueued once, under a deterministic job id; publications whose jobs are
// still queued, that are halted by a kill switch, or whose upload outcome is unknown are not.

const MIN = 60_000;

describe('lostPublishMarginMs (STUDIO_LOST_PUBLISH_MARGIN_MINUTES)', () => {
  it('defaults to 15 minutes and reads whole minutes from 5 to 1440', () => {
    expect(lostPublishMarginMs({})).toBe(15 * MIN);
    expect(lostPublishMarginMs({ STUDIO_LOST_PUBLISH_MARGIN_MINUTES: '30' })).toBe(30 * MIN);
    for (const bad of ['4', '1441', '2.5', 'soon'])
      expect(() => lostPublishMarginMs({ STUDIO_LOST_PUBLISH_MARGIN_MINUTES: bad })).toThrow(
        ConfigurationError,
      );
  });

  it('re-drive job ids are deterministic per publication, attempt and due time', () => {
    const due = new Date('2026-09-28T10:00:00Z');
    expect(redriveJobId('pub', 0, due)).toBe(`publish-video__pub__redrive__0__${due.getTime()}`);
    expect(redriveJobId('pub', 1, due)).not.toBe(redriveJobId('pub', 0, due));
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('redriveLostPublications', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `svc-lost-${randomUUID()}`;
  const logger = pino({ level: 'silent' });
  // Everything below was created "an hour ago" from the sweep's point of view.
  const now = () => Date.now() + 60 * MIN;
  let projectId = '';

  beforeAll(async () => {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'b',
        createdByUserId: 'u',
        name: 'Launch',
        state: 'PUBLISHING',
        sourceType: 'BRIEF',
        targetFormats: [],
        metadata: { runId: 'run-1', planTier: 'PLUS' },
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    const pubs = await db.videoPublication.findMany({
      where: { organisationId: org },
      select: { id: true },
    });
    await db.scheduledPublication.deleteMany({
      where: { publicationId: { in: pubs.map((p) => p.id) } },
    });
    await db.videoPublication.deleteMany({ where: { organisationId: org } });
    await db.videoRender.deleteMany({ where: { projectId } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function publication(
    input: {
      platform?: string;
      scheduledFor?: Date;
      createdAt?: Date;
      schedule?: 'PENDING' | 'FIRED';
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    const render = await db.videoRender.create({
      data: {
        projectId,
        scriptId: 'script',
        targetPlatform: input.platform ?? 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4500,
        s3Bucket: 'renders',
        s3Key: `k-${randomUUID()}`,
        qualityCheckState: 'PASSED',
      },
    });
    const pub = await db.videoPublication.create({
      data: {
        organisationId: org,
        projectId,
        renderId: render.id,
        platform: input.platform ?? 'tiktok',
        platformAccountId: 'acct',
        state: 'SCHEDULED',
        scheduledFor: input.scheduledFor ?? null,
        hashtags: [],
        metadata: (input.metadata ?? { connectionId: 'c' }) as Prisma.InputJsonValue,
        ...(input.createdAt && { createdAt: input.createdAt }),
      },
    });
    if (input.schedule && input.scheduledFor)
      await db.scheduledPublication.create({
        data: {
          publicationId: pub.id,
          scheduledFor: input.scheduledFor,
          state: input.schedule,
          jobId: jobIds.fireScheduled({
            publicationId: pub.id,
            projectId,
            organisationId: org,
            runId: 'run-1',
            planTier: 'PLUS',
          }),
        },
      });
    return pub;
  }

  function harness() {
    const queue = new InlineJobQueue();
    const audits: AuditEntry[] = [];
    const killSwitch = {
      check: async (scope: KillSwitchScope): Promise<KillSwitchStatus> =>
        scope.platform === 'youtube'
          ? { killed: true, level: 'platform', key: 'studio.disabledPlatform.youtube' }
          : { killed: false },
    };
    const run = () =>
      redriveLostPublications({
        db,
        queue,
        killSwitch,
        audit: (e) => audits.push(e),
        logger,
        now,
        organisationId: org,
      });
    return { queue, audits, run };
  }

  it('re-enqueues a lost immediate publication once, with its recorded run and tier', async () => {
    const lost = await publication();
    const { queue, audits, run } = harness();
    const first = await run();
    expect(first.redriven).toContain(lost.id);
    const jobs = queue.history.filter(
      (j) => j.name === 'publish-video' && j.data.projectId === projectId,
    );
    const job = jobs.find((j) => (j.data as { publicationId: string }).publicationId === lost.id);
    expect(job?.jobId).toBe(redriveJobId(lost.id, 0, lost.createdAt));
    expect(job?.data).toMatchObject({
      publicationId: lost.id,
      organisationId: org,
      projectId,
      runId: 'run-1',
      planTier: 'PLUS',
    });
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: REDRIVE_ACTOR,
        action: 'studio.publication.lost_job_redriven',
        resource: { type: 'video_publication', id: lost.id },
      }),
    );

    // The next sweep sees the re-drive queued (and after it ran, as done): never a second job.
    const second = await run();
    expect(second.redriven).not.toContain(lost.id);
    expect(second.skipped).toContainEqual({ id: lost.id, reason: 're-drive already queued' });
    // Take the jobs off the queue without running them: they now count as finished.
    let drained = queue.take();
    while (drained) drained = queue.take();
    const third = await run();
    expect(third.skipped).toContainEqual({
      id: lost.id,
      reason: 'already re-driven once; check it by hand',
    });
    expect(
      queue.history.filter((j) => j.jobId === redriveJobId(lost.id, 0, lost.createdAt)),
    ).toHaveLength(1);
  });

  it('leaves a publication whose publish job is still queued', async () => {
    const queuedPub = await publication();
    const { queue, run } = harness();
    await queue.add(
      'publish-video',
      {
        publicationId: queuedPub.id,
        projectId,
        organisationId: org,
        runId: 'run-1',
        planTier: 'PLUS',
      },
      {
        jobId: jobIds.publishVideo({
          publicationId: queuedPub.id,
          projectId,
          organisationId: org,
          runId: 'run-1',
          planTier: 'PLUS',
        }),
      },
    );
    const out = await run();
    expect(out.skipped).toContainEqual({ id: queuedPub.id, reason: 'publish job still queued' });
  });

  it('ignores publications inside the margin (the enqueue may still be on its way)', async () => {
    const fresh = await publication({ createdAt: new Date(now() - 5 * MIN) });
    const { run } = harness();
    const out = await run();
    expect(out.redriven).not.toContain(fresh.id);
    expect(out.skipped.map((s) => s.id)).not.toContain(fresh.id);
  });

  it('consumes a lost fire-scheduled job and re-drives the publication', async () => {
    const due = new Date(now() - 30 * MIN);
    const scheduled = await publication({ scheduledFor: due, schedule: 'PENDING' });
    const handedOff = await publication({ scheduledFor: due, schedule: 'FIRED' });
    const { queue, run } = harness();
    const out = await run();
    expect(out.redriven).toEqual(expect.arrayContaining([scheduled.id, handedOff.id]));
    expect(
      (await db.scheduledPublication.findUniqueOrThrow({ where: { publicationId: scheduled.id } }))
        .state,
    ).toBe('FIRED');
    expect(queue.history.map((j) => j.jobId)).toContain(redriveJobId(scheduled.id, 0, due));
  });

  it('leaves a scheduled publication whose fire job is still queued, or not yet due', async () => {
    const due = new Date(now() - 30 * MIN);
    const waiting = await publication({ scheduledFor: due, schedule: 'PENDING' });
    const later = await publication({
      scheduledFor: new Date(now() + 60 * MIN),
      schedule: 'PENDING',
    });
    const { queue, run } = harness();
    const data = {
      publicationId: waiting.id,
      projectId,
      organisationId: org,
      runId: 'run-1',
      planTier: 'PLUS' as const,
    };
    await queue.add('fire-scheduled-publication', data, { jobId: jobIds.fireScheduled(data) });
    const out = await run();
    expect(out.skipped).toContainEqual({
      id: waiting.id,
      reason: 'fire-scheduled job still queued',
    });
    expect(out.redriven).not.toContain(later.id);
    expect(
      (await db.scheduledPublication.findUniqueOrThrow({ where: { publicationId: waiting.id } }))
        .state,
    ).toBe('PENDING');
  });

  it('respects the platform kill switch and an unknown upload outcome', async () => {
    const halted = await publication({ platform: 'youtube' });
    const uncertain = await publication({
      metadata: { connectionId: 'c', uploadStartedAt: new Date().toISOString() },
    });
    const { queue, run } = harness();
    const out = await run();
    expect(out.skipped).toContainEqual({ id: halted.id, reason: 'kill_switch_engaged: platform' });
    expect(out.skipped).toContainEqual({
      id: uncertain.id,
      reason: 'upload outcome unknown; check the platform first',
    });
    const ids = queue.history.map((j) => (j.data as { publicationId?: string }).publicationId);
    expect(ids).not.toContain(halted.id);
    expect(ids).not.toContain(uncertain.id);
    expect((await db.videoPublication.findUniqueOrThrow({ where: { id: halted.id } })).state).toBe(
      'SCHEDULED',
    );
  });
});
