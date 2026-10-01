import type { PrismaClient } from '@prisma/client';
import { Queue, type ConnectionOptions } from 'bullmq';
import { StudioError, UpstreamServiceError } from '../../errors';
import type { BreakerState, CircuitBreaker } from '../providers/circuit-breaker';
import { CLIENT_SIDE_ERROR_CLASSES, type ProviderErrorClass } from '../providers/interface';
import { utcDay } from '../providers/job-repository';
import type { ProviderRegistry } from '../providers/registry';
import { QUEUES } from '../queue/queues';
import { queuePrefix } from '../queue/redis';

// BACKLOG 13.16 / spec 16.4 Admin Centre "Queue health" and "Provider health".
//   GET /admin/queues     BullMQ depths per queue and the age of the oldest waiting job.
//   GET /admin/providers  per provider: the shared (Redis) breaker state, the error rate of
//                         provider jobs started in the last hour, and today's spend (UTC).
// Both are read-only views of state that already exists (Redis, provider_jobs, provider_usage).

export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  /** Seconds the oldest waiting (or prioritised) job has waited; null when none is waiting. */
  oldestWaitingSec: number | null;
}

/** The part of a BullMQ Queue the report reads (tests pass doubles). */
export interface InspectableQueue {
  readonly name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJobs(
    types: string[],
    start: number,
    end: number,
    asc: boolean,
  ): Promise<Array<{ timestamp: number } | undefined>>;
}

export const QUEUE_REPORT_TIMEOUT_MS = 3_000;

async function oldestTimestamp(queue: InspectableQueue): Promise<number | null> {
  const [wait, prioritized] = await Promise.all([
    queue.getJobs(['wait'], 0, 0, true),
    queue.getJobs(['prioritized'], 0, 0, true),
  ]);
  const stamps = [wait[0]?.timestamp, prioritized[0]?.timestamp].filter(
    (t): t is number => typeof t === 'number',
  );
  return stamps.length ? Math.min(...stamps) : null;
}

export async function queueHealth(
  queues: readonly InspectableQueue[],
  now: number,
  timeoutMs = QUEUE_REPORT_TIMEOUT_MS,
): Promise<QueueHealth[]> {
  const report = Promise.all(
    queues.map(async (queue): Promise<QueueHealth> => {
      const [counts, oldest] = await Promise.all([
        queue.getJobCounts('waiting', 'prioritized', 'active', 'failed', 'delayed'),
        oldestTimestamp(queue),
      ]);
      return {
        name: queue.name,
        waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        oldestWaitingSec: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)),
      };
    }),
  );
  // BullMQ keeps retrying while Redis is down: answer 502 instead of hanging the admin page.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamServiceError('Queue health unavailable: Redis did not answer')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([report.catch(asRedisUnavailable('Queue health')), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A Redis error thrown by BullMQ (connection refused, a server too old for BullMQ) becomes a 502
 * with its reason, like the timeout, instead of an opaque 500 "Request failed" (20.10). Staff-only
 * screens, so the reason is shown.
 */
export function asRedisUnavailable(what: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof StudioError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamServiceError(`${what} unavailable: Redis error (${reason})`);
  };
}

let bullQueues: Queue[] | undefined;

/** One BullMQ Queue handle per Studio queue, created once per process. */
export function bullQueuesFor(connection: ConnectionOptions): InspectableQueue[] {
  bullQueues ??= Object.values(QUEUES).map((name) => {
    const queue = new Queue(name, { connection, prefix: queuePrefix() });
    queue.on('error', () => undefined); // reported by the request that times out
    return queue;
  });
  return bullQueues as unknown as InspectableQueue[];
}

export interface ProviderHealth {
  id: string;
  /** Registered in this deployment (its credentials are configured). */
  configured: boolean;
  breaker: BreakerState;
  /** Failed share of provider jobs started in the last hour that finished; null = none. */
  errorRate1h: number | null;
  jobs1h: { succeeded: number; failed: number; running: number };
  spendTodayPence: number;
  /**
   * 20.11: held out of routing for an account problem (bad key, no credits, usage limit): the
   * class, the provider's own message (staff only) and when it may be tried again (ISO).
   */
  accountHold: { errorClass: string; reason: string; until: string; since: string } | null;
  /** Configured, its breaker is not open and it is not held for an account problem. */
  healthy: boolean;
}

type HealthDb = Pick<PrismaClient, 'providerJob' | 'providerUsage'>;

const HOUR_MS = 60 * 60 * 1000;

function countsHealth(errorClass: string | null): boolean {
  return !CLIENT_SIDE_ERROR_CLASSES.has((errorClass ?? 'unknown') as ProviderErrorClass);
}

export async function providerHealth(
  deps: { db: HealthDb; registry: ProviderRegistry; breaker: CircuitBreaker },
  now: number,
): Promise<ProviderHealth[]> {
  const [jobs, spend, breakers, holds] = await Promise.all([
    deps.db.providerJob.groupBy({
      by: ['provider', 'state', 'errorClass'],
      where: { startedAt: { gte: new Date(now - HOUR_MS) } },
      _count: { _all: true },
    }),
    deps.db.providerUsage.groupBy({
      by: ['provider'],
      where: { day: utcDay(new Date(now)) },
      _sum: { costPence: true },
    }),
    deps.breaker.snapshot(),
    deps.breaker.accountHolds?.() ?? {},
  ]);
  const configured = new Set(deps.registry.list().map((a) => a.providerId));
  const ids = new Set([
    ...configured,
    ...Object.keys(breakers),
    ...jobs.map((j) => j.provider),
    ...spend.map((s) => s.provider),
  ]);
  const report = await Promise.all(
    [...ids].map(async (id): Promise<ProviderHealth> => {
      const tally = { succeeded: 0, failed: 0, running: 0, healthFailures: 0 };
      for (const row of jobs.filter((j) => j.provider === id)) {
        const n = row._count._all;
        if (row.state === 'SUCCEEDED') tally.succeeded += n;
        else if (row.state === 'FAILED' || row.state === 'TIMED_OUT') {
          tally.failed += n;
          // Client-side refusals (invalid input, content policy) say nothing about health.
          if (countsHealth(row.errorClass)) tally.healthFailures += n;
        } else if (row.state === 'RUNNING' || row.state === 'PENDING') tally.running += n;
      }
      const finished = tally.succeeded + tally.failed;
      const breaker = breakers[id] ?? (await deps.breaker.state(id));
      const isConfigured = configured.has(id);
      const hold = holds[id];
      return {
        id,
        configured: isConfigured,
        breaker,
        errorRate1h:
          finished === 0 ? null : Math.round((tally.healthFailures / finished) * 1000) / 1000,
        jobs1h: { succeeded: tally.succeeded, failed: tally.failed, running: tally.running },
        spendTodayPence: spend.find((s) => s.provider === id)?._sum.costPence ?? 0,
        accountHold: hold
          ? {
              errorClass: hold.errorClass,
              reason: hold.reason,
              until: new Date(hold.until).toISOString(),
              since: new Date(hold.since).toISOString(),
            }
          : null,
        healthy: isConfigured && breaker !== 'open' && !hold,
      };
    }),
  );
  return report.sort((a, b) => a.id.localeCompare(b.id));
}
