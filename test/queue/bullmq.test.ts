import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Queue, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBullJobQueue, jobIds } from '../../src/lib/studio/queue/enqueue';
import { QUEUES, type ProjectJobData } from '../../src/lib/studio/queue/queues';
import { redisConnectionFromEnv } from '../../src/lib/studio/queue/redis';
import { startWorkers } from '../../src/lib/studio/queue/worker-host';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// The same pipeline as test/db/pipeline.test.ts, but through real BullMQ on Redis 7 (CI).
// Proves queue wiring: job routing across the two queues, fan-in via deterministic job ids,
// UnrecoverableError on kill switch, and failed jobs retained (dead-letter).

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!enabled)('pipeline on real BullMQ', { timeout: 60_000 }, () => {
  const db = enabled ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const organisationId = `bullmq-${randomUUID()}`;
  const prefix = `studio-test-${randomUUID().slice(0, 8)}`;
  let workers: Worker[] = [];
  let queue: ReturnType<typeof createBullJobQueue>;

  beforeAll(async () => {
    vi.stubEnv('BULLMQ_QUEUE_PREFIX', prefix);
    const connection = redisConnectionFromEnv();
    queue = createBullJobQueue(connection);
    const h = createHarness(db);
    workers = startWorkers({ connection, deps: { ...h.deps, queue } });
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await queue?.close();
    await db.systemFlag.deleteMany({ where: { key: { contains: organisationId } } });
    vi.unstubAllEnvs();
    await db.$disconnect();
  });

  it('runs a project to READY_FOR_REVIEW across both queues', async () => {
    const { project, runId } = await createProject(db, { organisationId });
    const job: ProjectJobData = { projectId: project.id, organisationId, runId, planTier: 'PLUS' };
    await queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
    const state = await waitFor(async () => {
      const p = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
      return ['READY_FOR_REVIEW', 'QUALITY_FAILED', 'FAILED'].includes(p.state)
        ? p.state
        : undefined;
    });
    expect(state).toBe('READY_FOR_REVIEW');
  });

  it('fails a frozen workspace unrecoverably and keeps the failed job', async () => {
    const org = `${organisationId}-frozen`;
    await db.systemFlag.create({ data: { key: flagKeys.workspace(org), value: 'true' } });
    const { project, runId } = await createProject(db, { organisationId: org });
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: org,
      runId,
      planTier: 'BASIC',
    };
    await queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
    await waitFor(async () => {
      const p = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
      return p.state === 'FAILED' ? p : undefined;
    });
    const orchestration = new Queue(QUEUES.orchestration, {
      connection: redisConnectionFromEnv(),
      prefix,
    });
    const failed = await waitFor(
      async () => (await orchestration.getJob(jobIds.planProject(job)))?.failedReason || undefined,
    );
    expect(failed).toContain('kill_switch_workspace');
    const stored = await orchestration.getJob(jobIds.planProject(job));
    expect(stored?.attemptsMade).toBe(1); // no retries for unrecoverable errors
    await orchestration.close();
  });
});
