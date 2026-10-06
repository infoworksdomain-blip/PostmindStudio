import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProviderPollResult, ProviderRequest } from '../../src/lib/studio/providers/interface';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// BACKLOG 23.1 — a project with several aspect ratios submits every Shotstack render before
// waiting for any of them, and one failing render does not abandon (or re-submit) the others:
// the finished renders are recorded and only the failed variant is rendered again.

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = `prender-${randomUUID().slice(0, 8)}`;
// Three platform variants (the harness's media inspector reports 1080×1920 renders, so the
// quality gate passes portrait variants only).
const FORMATS = [
  { platform: 'tiktok', aspectRatio: '9:16', duration: 15 },
  { platform: 'instagram_reel', aspectRatio: '9:16', duration: 15 },
  { platform: 'youtube_short', aspectRatio: '9:16', duration: 15 },
];

describe.skipIf(!hasDb)('parallel multi-format renders (23.1)', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  afterAll(async () => {
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { startsWith: PREFIX } },
        select: { id: true },
      })
    ).map((p) => p.id);
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

  /** A Shotstack double that logs submits and polls in order. */
  function instrumented(h: ReturnType<typeof createHarness>) {
    const events: string[] = [];
    const shotstack = h.adapters.shotstack;
    const submit = shotstack.submit.bind(shotstack);
    const poll = shotstack.poll.bind(shotstack);
    shotstack.submit = async (request: ProviderRequest) => {
      events.push('submit');
      return submit(request);
    };
    shotstack.poll = async (id: string): Promise<ProviderPollResult> => {
      events.push('poll');
      return poll(id);
    };
    shotstack.pollsBeforeDone = 1;
    return events;
  }

  async function run(h: ReturnType<typeof createHarness>) {
    const org = `${PREFIX}-${randomUUID().slice(0, 6)}`;
    const { project, runId } = await createProject(db, {
      organisationId: org,
      targetFormats: FORMATS,
    });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: org,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    const result = await drainInline(h.queue, h.deps);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    return { result, project: after };
  }

  it('submits every variant before polling any of them', async () => {
    const h = createHarness(db);
    const events = instrumented(h);
    const { result, project } = await run(h);
    expect(result.failedJobs).toEqual([]);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(events.filter((e) => e === 'submit')).toHaveLength(FORMATS.length);
    expect(events.indexOf('poll')).toBe(FORMATS.length); // all three submits come first
    const renders = await db.videoRender.findMany({ where: { projectId: project.id } });
    expect(renders.map((r) => r.targetPlatform).sort()).toEqual([
      'instagram_reel',
      'tiktok',
      'youtube_short',
    ]);
    // Cost tracking per variant: one provider job and cost per render.
    expect(renders.every((r) => r.costPence === 30)).toBe(true);
    expect(
      await db.providerJob.count({ where: { projectId: project.id, provider: 'shotstack' } }),
    ).toBe(FORMATS.length);
  });

  it('one failing render does not block the others; only it is rendered again', async () => {
    const h = createHarness(db);
    const ok = h.adapters.shotstack.respond;
    // The second render submitted fails once with a retryable fault (R2 download timeout).
    h.adapters.shotstack.respond = (request) => {
      if (h.adapters.shotstack.requests.length === 2) {
        return {
          state: 'failed',
          error: { class: 'timeout', message: 'Connection timeout', retryable: true },
        };
      }
      return ok(request);
    };
    const { result, project } = await run(h);
    expect(result.failedJobs).toEqual([]);
    expect(project.state).toBe('READY_FOR_REVIEW');
    // 3 first submits + 1 retry of the failed variant (not 3 more).
    expect(h.adapters.shotstack.requests).toHaveLength(FORMATS.length + 1);
    const renders = await db.videoRender.findMany({ where: { projectId: project.id } });
    expect(renders).toHaveLength(FORMATS.length);
    const jobs = await db.providerJob.findMany({
      where: { projectId: project.id, provider: 'shotstack' },
      select: { state: true },
    });
    expect(jobs.filter((j) => j.state === 'TIMED_OUT')).toHaveLength(1);
    expect(jobs.filter((j) => j.state === 'SUCCEEDED')).toHaveLength(FORMATS.length);
  });
});
