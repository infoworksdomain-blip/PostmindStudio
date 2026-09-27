import { Worker, type ConnectionOptions } from 'bullmq';
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
};

const CONCURRENCY_ENV: Record<QueueName, string> = {
  [QUEUES.orchestration]: 'WORKER_CONCURRENCY_ORCHESTRATION',
  [QUEUES.assets]: 'WORKER_CONCURRENCY_ASSETS',
  [QUEUES.publish]: 'WORKER_CONCURRENCY_PUBLISH',
  [QUEUES.scheduled]: 'WORKER_CONCURRENCY_SCHEDULED',
  [QUEUES.analytics]: 'WORKER_CONCURRENCY_ANALYTICS',
};

export function concurrencyFor(
  queue: QueueName,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env[CONCURRENCY_ENV[queue]]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CONCURRENCY[queue];
}

/** Queues with processors today; the analytics worker arrives in Phase 11. */
export const PIPELINE_QUEUES: QueueName[] = [
  QUEUES.orchestration,
  QUEUES.assets,
  QUEUES.publish,
  QUEUES.scheduled,
];

export function startWorkers(input: {
  connection: ConnectionOptions;
  deps: PipelineDeps;
  queues?: QueueName[];
}): Worker[] {
  return (input.queues ?? PIPELINE_QUEUES).map((queue) => {
    const worker = new Worker(
      queue,
      async (job) => {
        await executeJob(job.name as JobName, job.data as JobDataMap[JobName], input.deps, {
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
        });
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
