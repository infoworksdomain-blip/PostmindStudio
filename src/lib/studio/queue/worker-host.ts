import { DelayedError, Worker, type ConnectionOptions } from 'bullmq';
import { RateDeferredError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import { QUEUES, retryDelayMs, type JobDataMap, type JobName, type QueueName } from './queues';
import { queuePrefix } from './redis';
import { executeJob } from './workers/runtime';

// Binds BullMQ workers to the pipeline processors. Concurrency per spec 11.1, overridable via
// WORKER_CONCURRENCY_* (see .env.example).

export const DEFAULT_CONCURRENCY: Record<QueueName, number> = {
  [QUEUES.orchestration]: 10,
  [QUEUES.assets]: 15,
  [QUEUES.publish]: 5,
  [QUEUES.scheduled]: 3,
  [QUEUES.analytics]: 5,
  [QUEUES.library]: 2,
};

const CONCURRENCY_ENV: Record<QueueName, string> = {
  [QUEUES.orchestration]: 'WORKER_CONCURRENCY_ORCHESTRATION',
  [QUEUES.assets]: 'WORKER_CONCURRENCY_ASSETS',
  [QUEUES.publish]: 'WORKER_CONCURRENCY_PUBLISH',
  [QUEUES.scheduled]: 'WORKER_CONCURRENCY_SCHEDULED',
  [QUEUES.analytics]: 'WORKER_CONCURRENCY_ANALYTICS',
  [QUEUES.library]: 'WORKER_CONCURRENCY_LIBRARY',
};

/** Corpus ingestion throughput knob (runbooks/corpus-ingestion.md); wins over the legacy name. */
export const LIBRARY_CONCURRENCY_ENV = 'STUDIO_LIBRARY_CONCURRENCY';
/** Each library job buffers up to 200 MB of source: refuse absurd values. */
export const MAX_LIBRARY_CONCURRENCY = 32;

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function concurrencyFor(
  queue: QueueName,
  env: Record<string, string | undefined> = process.env,
): number {
  if (queue === QUEUES.library) {
    const n = positiveInt(env[LIBRARY_CONCURRENCY_ENV]) ?? positiveInt(env[CONCURRENCY_ENV[queue]]);
    return n ? Math.min(n, MAX_LIBRARY_CONCURRENCY) : DEFAULT_CONCURRENCY[queue];
  }
  return positiveInt(env[CONCURRENCY_ENV[queue]]) ?? DEFAULT_CONCURRENCY[queue];
}

/** Every queue has processors (analytics since Phase 11). */
export const PIPELINE_QUEUES: QueueName[] = [
  QUEUES.orchestration,
  QUEUES.assets,
  QUEUES.publish,
  QUEUES.scheduled,
  QUEUES.library,
  QUEUES.analytics,
];

/**
 * 15.C3 (spec 11.4): a full provider rate window moves the job to the delayed set until the
 * window frees. BullMQ's documented pattern (https://docs.bullmq.io/patterns/process-step-jobs,
 * read 2026-09-28): `await job.moveToDelayed(ts, token); throw new DelayedError()` — "Manually
 * moving jobs using special errors does not increment the attemptsMade property".
 */
export async function deferIfRateLimited(
  err: unknown,
  job: { moveToDelayed(timestamp: number, token?: string): Promise<void> },
  token: string | undefined,
  now: () => number,
): Promise<void> {
  if (!(err instanceof RateDeferredError)) return;
  await job.moveToDelayed(now() + err.retryAfterMs, token);
  throw new DelayedError();
}

export function startWorkers(input: {
  connection: ConnectionOptions;
  deps: PipelineDeps;
  queues?: QueueName[];
}): Worker[] {
  return (input.queues ?? PIPELINE_QUEUES).map((queue) => {
    const worker = new Worker(
      queue,
      async (job, token) => {
        try {
          await executeJob(job.name as JobName, job.data as JobDataMap[JobName], input.deps, {
            attemptsMade: job.attemptsMade,
            maxAttempts: job.opts.attempts ?? 1,
          });
        } catch (err) {
          await deferIfRateLimited(err, job, token, input.deps.now);
          throw err;
        }
      },
      {
        connection: input.connection,
        prefix: queuePrefix(),
        concurrency: concurrencyFor(queue),
        settings: { backoffStrategy: (attemptsMade: number) => retryDelayMs(attemptsMade) },
      },
    );
    worker.on('error', (err) => input.deps.logger.error({ err, queue }, 'worker error'));
    return worker;
  });
}
