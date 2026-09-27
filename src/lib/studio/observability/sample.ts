import type { PrismaClient } from '@prisma/client';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { CircuitBreaker } from '../providers/circuit-breaker';
import { QUEUES } from '../queue/queues';
import { FLAG_OFF, flagKeys } from '../system-flags';
import { queuePrefix } from '../queue/redis';
import { BREAKER_VALUE, type StudioMetrics } from './metrics';

// Scrape-time samples for gauges: BullMQ depths (spec 16.4 "Queue health") and this process's
// circuit-breaker states (spec 16.4 "Provider health"; shared through Redis since 13.16).

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'prioritized'] as const;

let queues: Queue[] | undefined;

export async function sampleQueueDepths(
  metrics: StudioMetrics,
  connection: ConnectionOptions,
  timeoutMs = 2_000,
): Promise<void> {
  queues ??= Object.values(QUEUES).map((name) => {
    const queue = new Queue(name, { connection, prefix: queuePrefix() });
    // Sampling failures are reported by the caller; keep connection errors from going unhandled.
    queue.on('error', () => undefined);
    return queue;
  });
  const sampling = Promise.all(
    queues.map(async (queue) => {
      const counts = await queue.getJobCounts(...QUEUE_STATES);
      for (const state of QUEUE_STATES) {
        metrics.queueDepth.set({ queue: queue.name, state }, counts[state] ?? 0);
      }
    }),
  );
  // BullMQ keeps retrying while Redis is down: never let a scrape hang on it.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('queue depth sampling timed out')), timeoutMs);
  });
  try {
    await Promise.race([sampling, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sampleBreakers(
  metrics: StudioMetrics,
  breaker: CircuitBreaker,
): Promise<void> {
  for (const [provider, state] of Object.entries(await breaker.snapshot())) {
    metrics.breakerState.set({ provider }, BREAKER_VALUE[state] ?? 0);
  }
}

/**
 * Kill-switch flags engaged per level (spec 12): one indexed read of system_flags. Levels come
 * from flagKeys, so a new level is sampled without changes here. Any value other than 'false'
 * counts as engaged, matching the kill switch's fail-closed reading.
 */
export async function sampleKillSwitch(
  metrics: StudioMetrics,
  db: Pick<PrismaClient, 'systemFlag'>,
): Promise<void> {
  const levels = Object.entries(flagKeys).map(([level, key]) => {
    const exact = (key as (arg: string) => string)('');
    // Parameterised keys end with '.': everything under that prefix; global is one exact key.
    return { level, exact, prefix: exact.endsWith('.') ? exact : undefined };
  });
  const rows = await db.systemFlag.findMany({
    where: { key: { startsWith: 'studio.' }, NOT: { value: FLAG_OFF } },
    select: { key: true },
  });
  for (const { level, exact, prefix } of levels) {
    const count = rows.filter((r) => (prefix ? r.key.startsWith(prefix) : r.key === exact)).length;
    metrics.killSwitchEngaged.set({ level }, count);
  }
}
