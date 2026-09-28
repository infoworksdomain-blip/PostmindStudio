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
  /** Remove a waiting or delayed job by id (no-op when absent). Optional: best effort only. */
  remove?(name: JobName, jobId: string): Promise<void>;
  /**
   * 17.2: whether a job id is still queued ('pending': waiting, delayed, active, prioritized),
   * already ran ('finished': completed or failed, still retained — a re-add with that id is
   * ignored), or is unknown to the queue (undefined). Optional: absent = cannot tell.
   */
  jobState?(name: JobName, jobId: string): Promise<JobPresence | undefined>;
}

export type JobPresence = 'pending' | 'finished';

/** Deterministic job ids so fan-in / retries can never enqueue the same step twice per run. */
export const jobIds = {
  planProject: (d: JobDataMap['plan-project']) => `plan-project__${d.projectId}__${d.runId}`,
  generateAsset: (d: JobDataMap['generate-asset']) => `generate-asset__${d.shotId}__${d.runId}`,
  composeVideo: (d: JobDataMap['compose-video']) => `compose-video__${d.projectId}__${d.runId}`,
  generateThumbnail: (d: JobDataMap['generate-thumbnail']) =>
    `generate-thumbnail__${d.projectId}__${d.runId}`,
  publishVideo: (d: JobDataMap['publish-video'], attempt = 0) =>
    `publish-video__${d.publicationId}__${attempt}`,
  fireScheduled: (d: JobDataMap['fire-scheduled-publication']) =>
    `fire-scheduled__${d.publicationId}`,
  scanWebsite: (d: JobDataMap['scan-website']) => `scan-website__${d.scanId}`,
  ingestLibraryVideo: (d: JobDataMap['ingest-library-video']) => `ingest-library-video__${d.runId}`,
  reanalyseLibraryVideo: (d: JobDataMap['reanalyse-library-video']) =>
    `reanalyse-library-video__${d.libraryItemId}__${d.runId}`,
  pollAnalytics: (d: JobDataMap['poll-publication-analytics']) =>
    `poll-analytics__${d.publicationId}__${d.pollNumber}`,
  rollUpAnalytics: (d: JobDataMap['roll-up-analytics']) => `roll-up-analytics__${d.runId}`,
  populateSlideshow: (d: JobDataMap['populate-slideshow']) =>
    `populate-slideshow__${d.projectId}__${d.runId}`,
  refreshImageLibrary: (d: JobDataMap['refresh-image-library']) =>
    `refresh-image-library__${d.businessId}__${d.runId}`,
  runQualityGate: (d: JobDataMap['run-quality-gate']) =>
    `run-quality-gate__${d.projectId}__${d.runId}`,
  /** One scheduled rescan per last-scan per day (13.10). */
  rescanWebsite: (d: JobDataMap['rescan-website']) => `rescan-website__${d.scanId}__${d.runId}`,
  /** 15.E1: one job per export. */
  exportAccountData: (d: JobDataMap['export-account-data']) => `export-account-data__${d.exportId}`,
  purgeDisputedDomain: (d: JobDataMap['purge-disputed-domain']) =>
    `purge-disputed-domain__${d.runId}`,
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
    async remove(name, jobId) {
      // Queue.remove resolves 0 when the job is missing or locked by a worker (bullmq docs).
      await queueFor(JOB_QUEUE[name]).remove(jobId);
    },
    async jobState(name, jobId) {
      // Queue.getJob resolves undefined for an unknown id; Job.getState names its set.
      const job = await queueFor(JOB_QUEUE[name]).getJob(jobId);
      if (!job) return undefined;
      const state = await job.getState();
      if (state === 'unknown') return undefined;
      return state === 'completed' || state === 'failed' ? 'finished' : 'pending';
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

/** A dead-lettered inline job (BullMQ keeps these in the queue's failed set; 15.D4). */
export interface InlineFailedJob<N extends JobName = JobName> extends InlineJob<N> {
  id: string;
  failedReason: string;
  attemptsMade: number;
  timestamp: number;
  finishedOn: number;
}

/**
 * In-process queue: records jobs (deduplicating by jobId, like BullMQ) for a runner to execute.
 * Used by tests and the GATE 3 script so the whole pipeline runs without Redis.
 */
export class InlineJobQueue implements JobQueue {
  readonly pending: InlineJob[] = [];
  readonly history: InlineJob[] = [];
  /** Jobs of these names are held in `deferred` instead of running (e.g. recurring polls). */
  readonly defer = new Set<JobName>();
  readonly deferred: InlineJob[] = [];
  private readonly seen = new Set<string>();
  /** Jobs that exhausted their attempts (drainInline), for the dead-letter admin (15.D4). */
  readonly failed: InlineFailedJob[] = [];
  private failedSeq = 0;

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
    if (this.defer.has(name)) this.deferred.push(job);
    else this.pending.push(job);
    this.history.push(job);
  }

  async remove(_name: JobName, jobId: string): Promise<void> {
    for (const list of [this.pending, this.deferred]) {
      const index = list.findIndex((job) => job.jobId === jobId);
      if (index !== -1) list.splice(index, 1);
    }
  }

  /** Move held jobs into the pending queue (runs them on the next drain). */
  release(name?: JobName): number {
    const keep: InlineJob[] = [];
    let moved = 0;
    for (const job of this.deferred.splice(0)) {
      if (!name || job.name === name) {
        this.pending.push(job);
        moved += 1;
      } else keep.push(job);
    }
    this.deferred.push(...keep);
    return moved;
  }

  /** Dead-letter a job that exhausted its attempts, as BullMQ moves it to the failed set. */
  fail(job: InlineJob, failedReason: string, attemptsMade: number, now = Date.now()): void {
    this.failedSeq += 1;
    this.failed.push({
      name: job.name,
      data: job.data,
      jobId: job.jobId,
      id: job.jobId ?? `inline-${this.failedSeq}`,
      failedReason,
      attemptsMade,
      timestamp: now,
      finishedOn: now,
    } as InlineFailedJob);
  }

  /** Run a dead-lettered job again (retry / requeue), bypassing the jobId dedupe of add(). */
  requeue(job: InlineJob): void {
    const again = { name: job.name, data: job.data, jobId: job.jobId } as InlineJob;
    this.pending.push(again);
    this.history.push(again);
  }

  async jobState(_name: JobName, jobId: string): Promise<JobPresence | undefined> {
    if ([...this.pending, ...this.deferred].some((job) => job.jobId === jobId)) return 'pending';
    return this.seen.has(jobId) ? 'finished' : undefined;
  }

  take(): InlineJob | undefined {
    return this.pending.shift();
  }
}
