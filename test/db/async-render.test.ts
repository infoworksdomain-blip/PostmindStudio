import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { projectMetadata } from '../../src/lib/studio/pipeline/project-state';
import { pollRenders, wakeRenderPoll } from '../../src/lib/studio/pipeline/render-async';
import { pendingRendersOf } from '../../src/lib/studio/pipeline/render-state';
import type { InlineJob } from '../../src/lib/studio/queue/enqueue';
import type { JobName, ProjectJobData } from '../../src/lib/studio/queue/queues';
import { drainInline, executeJob } from '../../src/lib/studio/queue/workers/runtime';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// BACKLOG 23.6 — compose-video submits the external render(s) and returns (no queue slot held
// while Shotstack works); poll-render finishes them, driven by delayed polls or a render callback,
// exactly once however many polls / callbacks arrive; timeouts and retries as before.

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = `arender-${randomUUID().slice(0, 8)}`;
type Harness = ReturnType<typeof createHarness>;

describe.skipIf(!hasDb)('asynchronous renders (23.6)', { timeout: 120_000 }, () => {
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

  async function start(h: Harness, formats?: Array<Record<string, unknown>>) {
    const org = `${PREFIX}-${randomUUID().slice(0, 6)}`;
    const { project, runId } = await createProject(db, {
      organisationId: org,
      ...(formats && { targetFormats: formats as never }),
    });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: org,
      runId,
      planTier: 'STANDARD',
    };
    await h.queue.add('plan-project', job);
    return job;
  }

  /** Run queued jobs one at a time until (and including) the first job named `name`. */
  async function runThrough(h: Harness, name: JobName, before?: (job: InlineJob) => void) {
    const ran: string[] = [];
    for (let job = h.queue.take(); job; job = h.queue.take()) {
      if (job.name === name) before?.(job);
      await executeJob(job.name, job.data as never, h.deps, { attemptsMade: 0, maxAttempts: 6 });
      ran.push(job.name);
      if (job.name === name) return ran;
    }
    throw new Error(`${name} never ran`);
  }

  const project = (job: ProjectJobData) =>
    db.videoProject.findUniqueOrThrow({ where: { id: job.projectId } });

  it('compose-video submits and returns; delayed polls finish the render', async () => {
    const h = createHarness(db);
    h.adapters.shotstack.pollsBeforeDone = 3;
    const job = await start(h);
    await runThrough(h, 'compose-video');
    // The job ended while the render is still running at the composer.
    const mid = await project(job);
    expect(mid.state).toBe('RENDERING');
    expect(Object.keys(pendingRendersOf(mid.metadata))).toHaveLength(1);
    expect(await db.videoRender.count({ where: { projectId: job.projectId } })).toBe(0);
    expect(h.queue.pending.map((j) => j.name)).toContain('poll-render');

    const result = await drainInline(h.queue, h.deps);
    expect(result.failedJobs).toEqual([]);
    const done = await project(job);
    expect(done.state).toBe('READY_FOR_REVIEW');
    expect(pendingRendersOf(done.metadata)).toEqual({});
    expect(projectMetadata(done.metadata).renderPollClaim).toBeUndefined();
    // Four looks at the render: three "running", one "done"; cost settled once.
    const polls = h.queue.history.filter((j) => j.name === 'poll-render');
    expect(polls).toHaveLength(4);
    const usage = await db.providerUsage.findMany({
      where: { organisationId: job.organisationId, provider: 'shotstack' },
    });
    expect(usage.reduce((n, u) => n + u.succeededCount, 0)).toBe(1);
    expect(h.queue.history.filter((j) => j.name === 'run-quality-gate')).toHaveLength(1);
  });

  it('a render callback promotes the delayed poll (no 20 s wait)', async () => {
    const h = createHarness(db);
    const job = await start(h);
    await runThrough(h, 'compose-video', () => {
      h.deps.config.providerPollIntervalMs = 20_000; // the delay compose gives the first poll
    });
    const poll = h.queue.pending.find((j) => j.name === 'poll-render');
    expect(poll?.delayMs).toBe(20_000);
    const entry = Object.values(pendingRendersOf((await project(job)).metadata))[0]!;
    expect(
      await wakeRenderPoll(h.deps, {
        projectId: job.projectId,
        providerJobRowId: entry.providerJobRowId,
      }),
    ).toBe('promoted');
    const slept: number[] = [];
    h.deps.sleep = async (ms) => void slept.push(ms);
    await drainInline(h.queue, h.deps);
    expect(slept).not.toContain(20_000);
    expect((await project(job)).state).toBe('READY_FOR_REVIEW');
    // A replayed callback after the render was recorded finds nothing to resume.
    expect(
      await wakeRenderPoll(h.deps, {
        projectId: job.projectId,
        providerJobRowId: entry.providerJobRowId,
      }),
    ).toBe('not_pending');
  });

  it('duplicate polls / wakes record and settle each render once', async () => {
    const h = createHarness(db);
    const job = await start(h);
    await runThrough(h, 'compose-video');
    const poll = (chain: string) => pollRenders({ ...job, chain, poll: 1 }, h.deps);
    const [a, b] = await Promise.all([poll('x'), poll('y')]);
    // One poll held the claim; the other stood aside.
    expect([a, b].filter((o) => o === null)).toHaveLength(1);
    expect(await poll('z')).toBeNull(); // the run moved on to the quality gate
    expect(await db.videoRender.count({ where: { projectId: job.projectId } })).toBe(1);
    const jobs = await db.providerJob.findMany({
      where: { projectId: job.projectId, provider: 'shotstack' },
    });
    expect(jobs.map((j) => j.state)).toEqual(['SUCCEEDED']);
    const usage = await db.providerUsage.findMany({
      where: { organisationId: job.organisationId, provider: 'shotstack' },
    });
    expect(usage.reduce((n, u) => n + u.succeededCount, 0)).toBe(1);
    await drainInline(h.queue, h.deps);
    expect((await project(job)).state).toBe('READY_FOR_REVIEW');
    expect(h.queue.history.filter((j) => j.name === 'run-quality-gate')).toHaveLength(1);
  });

  it('a render past the provider timeout is cancelled and re-submitted, then the run fails', async () => {
    const h = createHarness(db);
    h.adapters.shotstack.pollsBeforeDone = 1_000;
    const job = await start(h);
    await runThrough(h, 'compose-video', () => {
      h.deps.config.providerTimeoutMs = 0; // every render is past its deadline at its first poll
    });
    await drainInline(h.queue, h.deps);
    const failed = await project(job);
    expect(failed.state).toBe('FAILED');
    // Timed out at every look; after five timeouts the circuit breaker holds Shotstack out of
    // routing, so the last retry cannot route and the run fails (as the synchronous compose did).
    expect(failed.errorReason).toMatch(/^composition_failed: /);
    expect(h.adapters.shotstack.requests.length).toBeGreaterThanOrEqual(5);
    expect(h.adapters.shotstack.requests.length).toBeLessThanOrEqual(6);
    const jobs = await db.providerJob.findMany({
      where: { projectId: job.projectId, provider: 'shotstack' },
    });
    expect(jobs.every((j) => j.state === 'CANCELLED')).toBe(true);
    expect(pendingRendersOf(failed.metadata)).toEqual({});
  });

  it('multi-format: every variant is submitted at once and recorded as it finishes', async () => {
    const h = createHarness(db);
    h.adapters.shotstack.pollsBeforeDone = 2;
    const job = await start(h, [
      { platform: 'tiktok', aspectRatio: '9:16', duration: 15 },
      { platform: 'instagram_reel', aspectRatio: '9:16', duration: 15 },
      { platform: 'youtube_short', aspectRatio: '9:16', duration: 15 },
    ]);
    await runThrough(h, 'compose-video');
    expect(h.adapters.shotstack.requests).toHaveLength(3);
    expect(Object.keys(pendingRendersOf((await project(job)).metadata))).toHaveLength(3);
    await drainInline(h.queue, h.deps);
    const done = await project(job);
    expect(done.state).toBe('READY_FOR_REVIEW');
    const mastering = projectMetadata(done.metadata).mastering as Record<string, unknown>;
    expect(Object.keys(mastering)).toHaveLength(3);
    expect(await db.videoRender.count({ where: { projectId: job.projectId } })).toBe(3);
  });
});
