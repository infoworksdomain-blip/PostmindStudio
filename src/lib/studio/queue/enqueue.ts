import { Queue, type ConnectionOptions } from 'bullmq';
import {
  DEFAULT_JOB_OPTIONS,
  JOB_QUEUE,
  priorityFor,
  type JobDataMap,
  type JobName,
  type QueueName,
} from './queues';
import { queuePrefix } from './redis';

// BACKLOG 3.3 — typed enqueue helpers. Processors depend on the JobQueue interface, so the same
// code runs on BullMQ in production and on the inline queue in tests and GATE scripts.

export interface EnqueueOptions {
  /** Idempotency key: BullMQ ignores a second add with the same jobId. */
  jobId?: string;
  delayMs?: number;
}

export interface JobQueue {
  add<N extends JobName>(name: N, data: JobDataMap[N], options?: EnqueueOptions): Promise<void>;
}

/** Deterministic job ids so fan-in / retries can never enqueue the same step twice per run. */
export const jobIds = {
  planProject: (d: JobDataMap['plan-project']) => `plan-project__${d.projectId}__${d.runId}`,
  generateAsset: (d: JobDataMap['generate-asset']) => `generate-asset__${d.shotId}__${d.runId}`,
  composeVideo: (d: JobDataMap['compose-video']) => `compose-video__${d.projectId}__${d.runId}`,
  runQualityGate: (d: JobDataMap['run-quality-gate']) =>
    `run-quality-gate__${d.projectId}__${d.runId}`,
};

export function createBullJobQueue(
  connection: ConnectionOptions,
): JobQueue & { close(): Promise<void> } {
  const queues = new Map<QueueName, Queue>();
  const queueFor = (name: QueueName) => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection,
        prefix: queuePrefix(),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      queues.set(name, queue);
    }
    return queue;
  };
  return {
    async add(name, data, options = {}) {
      await queueFor(JOB_QUEUE[name]).add(name, data, {
        priority: priorityFor(data.planTier, data.batch),
        ...(options.jobId && { jobId: options.jobId }),
        ...(options.delayMs && { delay: options.delayMs }),
      });
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

export interface InlineJob<N extends JobName = JobName> {
  name: N;
  data: JobDataMap[N];
  jobId?: string;
}

/**
 * In-process queue: records jobs (deduplicating by jobId, like BullMQ) for a runner to execute.
 * Used by tests and the GATE 3 script so the whole pipeline runs without Redis.
 */
export class InlineJobQueue implements JobQueue {
  readonly pending: InlineJob[] = [];
  readonly history: InlineJob[] = [];
  private readonly seen = new Set<string>();

  async add<N extends JobName>(
    name: N,
    data: JobDataMap[N],
    options: EnqueueOptions = {},
  ): Promise<void> {
    if (options.jobId) {
      if (this.seen.has(options.jobId)) return;
      this.seen.add(options.jobId);
    }
    const job = { name, data, jobId: options.jobId } as InlineJob;
    this.pending.push(job);
    this.history.push(job);
  }

  take(): InlineJob | undefined {
    return this.pending.shift();
  }
}
