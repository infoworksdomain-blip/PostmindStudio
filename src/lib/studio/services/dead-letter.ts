import type { PrismaClient } from '@prisma/client';
import { Queue, type ConnectionOptions, type Job } from 'bullmq';
import { z } from 'zod';
import { ConflictError, NotFoundError, UpstreamServiceError, ValidationError } from '../../errors';
import { ACTIVE_PIPELINE_STATES, currentRunId } from '../pipeline/project-state';
import type { InlineFailedJob, InlineJobQueue, JobQueue } from '../queue/enqueue';
import {
  DEFAULT_JOB_OPTIONS,
  JOB_QUEUE,
  priorityFor,
  QUEUES,
  type JobDataMap,
  type JobName,
  type QueueName,
} from '../queue/queues';
import { queuePrefix, redisConnectionFromEnv } from '../queue/redis';
import { PROVIDER_IDS } from '../system-flags';
import { requeueGenerateAsset, type RequeueOutcome } from './dead-letter-requeue';
import { asRedisUnavailable } from './admin-health';

// BACKLOG 15.D4 / spec 11.5 "Dead-letter handling": "An Admin Centre view lists failed jobs with
// retry / inspect / drain / requeue-with-different-provider actions. Never auto-drain — always
// require operator action."
//
// Jobs that exhaust their attempts stay in BullMQ's failed set (queues.ts: removeOnFail false).
// This service reads and acts on that set through the DeadLetterQueue port, implemented on
// BullMQ Queues in production and on InlineJobQueue.failed in tests:
//
//   list     GET  /admin/queues/:name/failed         cursor paging, job data with secrets redacted
//   retry    POST …/failed/:jobId/retry              BullMQ Job.retry('failed'): the same job and
//                                                    data, attempts reset
//   requeue  POST …/failed/:jobId/requeue            a fresh job (same name, data and job id);
//                                                    optional providerId for generate-asset only
//   drain    POST …/failed/drain                     removes every failed job of one queue; the
//                                                    body must repeat the queue name exactly
//
// BullMQ docs: Job.retry — https://api.docs.bullmq.io/classes/v5.Job.html#retry
//              Queue.clean — https://api.docs.bullmq.io/classes/v5.Queue.html#clean
//              Queue.getFailed — https://api.docs.bullmq.io/classes/v5.Queue.html#getfailed

export interface DeadLetterJob {
  id: string;
  name: string;
  data: unknown;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  /** When the job was added (ms since epoch). */
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
}

/** The dead-letter operations on one queue (BullMQ in production, the inline queue in tests). */
export interface DeadLetterQueue {
  readonly name: string;
  countFailed(): Promise<number>;
  /** Newest first, inclusive indexes (BullMQ getFailed semantics). */
  listFailed(start: number, end: number): Promise<DeadLetterJob[]>;
  /** The job when it is currently in the failed set; undefined otherwise. */
  getFailed(jobId: string): Promise<DeadLetterJob | undefined>;
  /** Move the failed job back to waiting with its attempts reset. */
  retry(jobId: string): Promise<void>;
  /** Remove the failed job and add it again as a new job (same name, data and job id). */
  requeue(jobId: string): Promise<void>;
  /** Remove one failed job without running it. */
  remove(jobId: string): Promise<void>;
  /** Remove every failed job; resolves the number removed. */
  drain(): Promise<number>;
}

export const DEAD_LETTER_TIMEOUT_MS = 5_000;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const DRAIN_BATCH = 1_000;
/** Upper bound on one drain (BullMQ's clean works in batches; this stops a runaway loop). */
const MAX_DRAIN = 100_000;

const QUEUE_NAMES = Object.values(QUEUES) as readonly string[];

export function isQueueName(name: string): name is QueueName {
  return QUEUE_NAMES.includes(name);
}

// ---------------------------------------------------------------- redaction

export const REDACTED = '[redacted]';
const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|signature|private[-_]?key|session)/i;

/** Keep scheme, host and path of a URL; drop credentials and every query value and fragment. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'redacted');
    url.hash = '';
    return url.toString();
  } catch {
    return REDACTED;
  }
}

/** Scrub bearer tokens, key=value secrets and URL query strings out of free text. */
export function redactText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url))
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|secret|password|api[-_]?key|signature)[A-Za-z0-9_-]*)(\s*[=:]\s*)("?)(?!redacted\b)[^\s"&,;]+\3/gi,
      `$1$2${REDACTED}`,
    );
}

/**
 * Job data as an operator may see it: values under sensitive keys are replaced, URLs lose their
 * query strings (presigned S3 / provider CDN links are bearer credentials) and free text is
 * scrubbed. Studio job payloads carry ids, not secrets, but library ingestion carries source URLs.
 */
export function redactJobData(value: unknown, key = ''): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactJobData(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJobData(v, k)]));
  }
  return value;
}

export interface DeadLetterView {
  id: string;
  name: string;
  data: unknown;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  organisationId: string | null;
  projectId: string | null;
  addedAt: string;
  processedAt: string | null;
  failedAt: string | null;
  /** providerId is accepted on requeue (generate-asset only). */
  providerOverride: boolean;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function field(data: unknown, name: string): string | null {
  const value = (data as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : null;
}

export function toView(job: DeadLetterJob): DeadLetterView {
  return {
    id: job.id,
    name: job.name,
    data: redactJobData(job.data),
    failedReason: redactText(job.failedReason),
    // The first frames are enough to inspect; full traces are in the worker logs.
    stacktrace: job.stacktrace.slice(0, 3).map((s) => redactText(s).slice(0, 4_000)),
    attemptsMade: job.attemptsMade,
    organisationId: field(job.data, 'organisationId'),
    projectId: field(job.data, 'projectId'),
    addedAt: new Date(job.timestamp).toISOString(),
    processedAt: iso(job.processedOn),
    failedAt: iso(job.finishedOn),
    providerOverride: job.name === 'generate-asset',
  };
}

// ---------------------------------------------------------------- inputs

export const listFailedQuery = z.object({
  cursor: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const requeueInput = z
  .object({
    providerId: z.enum(PROVIDER_IDS).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

export const retryInput = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .strict();

export const drainInput = z
  .object({
    /** Must equal the queue name exactly: a drain is never automatic (spec 11.5). */
    confirm: z.string().max(64),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

// ---------------------------------------------------------------- cursor

export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw new ValidationError('Invalid cursor');
  return Number(match[1]);
}

// ---------------------------------------------------------------- service

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamServiceError('Dead-letter queue unavailable: Redis did not answer')),
      ms,
    );
  });
  try {
    return await Promise.race([work.catch(asRedisUnavailable('Dead-letter queue')), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function findQueue(queues: readonly DeadLetterQueue[], name: string): DeadLetterQueue {
  const queue = isQueueName(name) ? queues.find((q) => q.name === name) : undefined;
  if (!queue) throw new NotFoundError(`Unknown queue ${name}`, { queues: QUEUE_NAMES });
  return queue;
}

export interface FailedPage {
  queue: string;
  total: number;
  jobs: DeadLetterView[];
  nextCursor: string | null;
}

/**
 * One page of the failed set, newest first. The cursor is an offset into the set: jobs failing
 * while an operator pages shift later pages (acceptable for an inspection view).
 */
export async function listFailed(
  queue: DeadLetterQueue,
  query: z.infer<typeof listFailedQuery>,
  timeoutMs = DEAD_LETTER_TIMEOUT_MS,
): Promise<FailedPage> {
  const offset = decodeCursor(query.cursor);
  const [total, jobs] = await withTimeout(
    Promise.all([queue.countFailed(), queue.listFailed(offset, offset + query.limit - 1)]),
    timeoutMs,
  );
  const next = offset + jobs.length;
  return {
    queue: queue.name,
    total,
    jobs: jobs.map(toView),
    nextCursor: jobs.length === query.limit && next < total ? encodeCursor(next) : null,
  };
}

async function requireFailed(queue: DeadLetterQueue, jobId: string): Promise<DeadLetterJob> {
  const job = await queue.getFailed(jobId);
  if (!job) throw new NotFoundError(`No failed job ${jobId} in ${queue.name}`);
  return job;
}

const PIPELINE_JOBS = new Set<string>([
  'plan-project',
  'generate-asset',
  'compose-video',
  'run-quality-gate',
  'populate-slideshow',
]);

/**
 * Workers skip project pipeline jobs of an older run, or of a project that is no longer in the
 * pipeline (runtime.ts / project-state.ts). A retry of such a job is harmless but does nothing,
 * so the operator is told why and pointed at the tool that does resume it.
 */
export async function retryAdvisory(
  db: Pick<PrismaClient, 'videoProject'>,
  job: Pick<DeadLetterJob, 'name' | 'data'>,
): Promise<string | null> {
  if (!PIPELINE_JOBS.has(job.name)) return null;
  const projectId = field(job.data, 'projectId');
  const runId = field(job.data, 'runId');
  if (!projectId || !runId) return null;
  const project = await db.videoProject.findUnique({
    where: { id: projectId },
    select: { state: true, metadata: true, deletedAt: true },
  });
  if (!project || project.deletedAt)
    return 'The project no longer exists; the worker will skip this job.';
  if (currentRunId(project) !== runId) {
    return 'The project has started a newer run; the worker will skip this job.';
  }
  if (!ACTIVE_PIPELINE_STATES.includes(project.state)) {
    return job.name === 'generate-asset'
      ? `The project is ${project.state}; the worker will skip this job. Requeue it instead: that resumes the project's asset stage.`
      : `The project is ${project.state}; the worker will skip this job. Resume it with POST /admin/redrive or regenerate it.`;
  }
  return null;
}

export interface DeadLetterDeps {
  db: PrismaClient;
  /** Where a resumed project's new jobs go (ApiDeps.queue). */
  jobs: JobQueue;
  timeoutMs?: number;
}

export async function retryFailed(deps: DeadLetterDeps, queue: DeadLetterQueue, jobId: string) {
  const timeoutMs = deps.timeoutMs ?? DEAD_LETTER_TIMEOUT_MS;
  const job = await withTimeout(requireFailed(queue, jobId), timeoutMs);
  const advisory = await retryAdvisory(deps.db, job);
  await withTimeout(queue.retry(jobId), timeoutMs);
  return { job: { id: job.id, name: job.name, state: 'waiting' as const }, advisory };
}

export async function requeueFailed(
  deps: DeadLetterDeps,
  queue: DeadLetterQueue,
  jobId: string,
  input: z.infer<typeof requeueInput>,
): Promise<{ job: { id: string; name: string }; outcome: RequeueOutcome }> {
  const timeoutMs = deps.timeoutMs ?? DEAD_LETTER_TIMEOUT_MS;
  const job = await withTimeout(requireFailed(queue, jobId), timeoutMs);
  if (job.name === 'generate-asset') {
    const outcome = await requeueGenerateAsset(
      { db: deps.db, queue, jobs: deps.jobs },
      job.id,
      job.data as JobDataMap['generate-asset'],
      input.providerId,
    );
    return { job: { id: job.id, name: job.name }, outcome };
  }
  if (input.providerId) {
    throw new ValidationError(
      `providerId applies to generate-asset jobs only: ${job.name} jobs carry no provider preference (the router picks from a fixed candidate list)`,
      { jobName: job.name },
    );
  }
  await withTimeout(queue.requeue(jobId), timeoutMs);
  return { job: { id: job.id, name: job.name }, outcome: { action: 'requeued' } };
}

export async function drainFailed(
  queue: DeadLetterQueue,
  input: z.infer<typeof drainInput>,
  timeoutMs = DEAD_LETTER_TIMEOUT_MS,
): Promise<{ queue: string; removed: number }> {
  if (input.confirm !== queue.name) {
    throw new ValidationError(`Type the queue name (${queue.name}) exactly to confirm the drain`);
  }
  // Draining is slow on a large set; allow it longer than a single read.
  const removed = await withTimeout(queue.drain(), timeoutMs * 6);
  return { queue: queue.name, removed };
}

// ---------------------------------------------------------------- BullMQ adapter

function fromBull(job: Job): DeadLetterJob {
  return {
    id: job.id ?? '',
    name: job.name,
    data: job.data as unknown,
    failedReason: job.failedReason ?? '',
    stacktrace: job.stacktrace ?? [],
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
  };
}

export function bullDeadLetterQueue(queue: Queue): DeadLetterQueue {
  const failedJob = async (jobId: string): Promise<Job | undefined> => {
    const job = (await queue.getJob(jobId)) as Job | undefined;
    return job && (await job.isFailed()) ? job : undefined;
  };
  const mustFail = async (jobId: string): Promise<Job> => {
    const job = await failedJob(jobId);
    if (!job) throw new ConflictError(`Job ${jobId} is no longer in the failed set`);
    return job;
  };
  return {
    name: queue.name,
    countFailed: () => queue.getFailedCount(),
    async listFailed(start, end) {
      const jobs = (await queue.getFailed(start, end)) as Array<Job | undefined>;
      return jobs.filter((j): j is Job => Boolean(j)).map(fromBull);
    },
    async getFailed(jobId) {
      const job = await failedJob(jobId);
      return job ? fromBull(job) : undefined;
    },
    async retry(jobId) {
      await (
        await mustFail(jobId)
      ).retry('failed', {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
    },
    async requeue(jobId) {
      const job = await mustFail(jobId);
      const data = job.data as JobDataMap[JobName];
      await job.remove();
      await queue.add(job.name, data, {
        ...DEFAULT_JOB_OPTIONS,
        jobId,
        priority: priorityFor(data.planTier, data.batch),
      });
    },
    async remove(jobId) {
      await (await mustFail(jobId)).remove();
    },
    async drain() {
      let removed = 0;
      for (;;) {
        const batch = await queue.clean(0, DRAIN_BATCH, 'failed');
        removed += batch.length;
        if (batch.length < DRAIN_BATCH || removed >= MAX_DRAIN) return removed;
      }
    },
  };
}

let bullDeadLetters: DeadLetterQueue[] | undefined;

/** One dead-letter handle per Studio queue, created once per process. */
export function bullDeadLetterQueuesFor(connection: ConnectionOptions): DeadLetterQueue[] {
  bullDeadLetters ??= Object.values(QUEUES).map((name) => {
    const queue = new Queue(name, { connection, prefix: queuePrefix() });
    queue.on('error', () => undefined); // reported by the request that times out
    return bullDeadLetterQueue(queue);
  });
  return bullDeadLetters;
}

/** The route's queues: the injected ones (tests) or BullMQ over REDIS_URL. */
export function resolveDeadLetterQueues(injected?: () => DeadLetterQueue[]): DeadLetterQueue[] {
  return injected?.() ?? bullDeadLetterQueuesFor(redisConnectionFromEnv());
}

// ---------------------------------------------------------------- inline adapter

function fromInline(job: InlineFailedJob): DeadLetterJob {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    failedReason: job.failedReason,
    stacktrace: [],
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.timestamp,
    finishedOn: job.finishedOn,
  };
}

/** The inline queue's failed list, split per BullMQ queue (tests and GATE scripts). */
export function inlineDeadLetterQueues(inline: InlineJobQueue): DeadLetterQueue[] {
  return Object.values(QUEUES).map((name): DeadLetterQueue => {
    const own = () => inline.failed.filter((job) => JOB_QUEUE[job.name] === name).reverse();
    const take = (jobId: string) => {
      const index = inline.failed.findIndex(
        (job) => job.id === jobId && JOB_QUEUE[job.name] === name,
      );
      if (index === -1) throw new ConflictError(`Job ${jobId} is no longer in the failed set`);
      const [job] = inline.failed.splice(index, 1);
      return job as InlineFailedJob;
    };
    return {
      name,
      countFailed: async () => own().length,
      listFailed: async (start, end) =>
        own()
          .slice(start, end + 1)
          .map(fromInline),
      getFailed: async (jobId) => {
        const job = own().find((j) => j.id === jobId);
        return job ? fromInline(job) : undefined;
      },
      retry: async (jobId) => inline.requeue(take(jobId)),
      requeue: async (jobId) => inline.requeue(take(jobId)),
      remove: async (jobId) => void take(jobId),
      drain: async () => {
        const before = inline.failed.length;
        const keep = inline.failed.filter((job) => JOB_QUEUE[job.name] !== name);
        inline.failed.splice(0, inline.failed.length, ...keep);
        return before - keep.length;
      },
    };
  });
}
