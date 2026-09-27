import { Queue, type ConnectionOptions } from 'bullmq';
import type { CircuitBreaker } from '../providers/circuit-breaker';
import { QUEUES } from '../queue/queues';
import { queuePrefix } from '../queue/redis';
import { BREAKER_VALUE, type StudioMetrics } from './metrics';

// Scrape-time samples for gauges: BullMQ depths (spec 16.4 "Queue health") and this process's
// circuit-breaker states (spec 16.4 "Provider health").

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

export function sampleBreakers(metrics: StudioMetrics, breaker: CircuitBreaker): void {
  for (const [provider, state] of Object.entries(breaker.snapshot())) {
    metrics.breakerState.set({ provider }, BREAKER_VALUE[state] ?? 0);
  }
}
