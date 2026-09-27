import type { ConnectionOptions } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { CircuitBreaker } from '../providers/circuit-breaker';
import { getMetrics } from './metrics';

const queueCounts = vi.hoisted(() => new Map<string, Record<string, number>>());

vi.mock('bullmq', () => {
  class Queue {
    name: string;

    constructor(name: string) {
      this.name = name;
    }

    on(): void {
      // no-op: the real Queue wires an 'error' listener on the ioredis connection.
    }

    async getJobCounts(...states: string[]): Promise<Record<string, number>> {
      const counts = queueCounts.get(this.name) ?? {};
      const result: Record<string, number> = {};
      for (const state of states) {
        if (counts[state] !== undefined) result[state] = counts[state];
      }
      return result;
    }
  }
  return { Queue };
});

const { sampleBreakers, sampleQueueDepths } = await import('./sample');

async function gaugeValue(
  metric: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, string> }> }> },
  labels: Record<string, string>,
): Promise<number | undefined> {
  const snapshot = await metric.get();
  return snapshot.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  )?.value;
}

describe('sampleBreakers', () => {
  it('sets gauge value 0 for a closed breaker', async () => {
    const metrics = getMetrics();
    const breaker = { snapshot: () => ({ runway: 'closed' }) } as unknown as CircuitBreaker;

    sampleBreakers(metrics, breaker);

    const metric = metrics.registry.getSingleMetric('studio_provider_circuit_state');
    await expect(gaugeValue(metric as never, { provider: 'runway' })).resolves.toBe(0);
  });

  it('sets gauge value 1 for a half-open breaker', async () => {
    const metrics = getMetrics();
    const breaker = { snapshot: () => ({ luma: 'half_open' }) } as unknown as CircuitBreaker;

    sampleBreakers(metrics, breaker);

    const metric = metrics.registry.getSingleMetric('studio_provider_circuit_state');
    await expect(gaugeValue(metric as never, { provider: 'luma' })).resolves.toBe(1);
  });

  it('sets gauge value 2 for an open breaker', async () => {
    const metrics = getMetrics();
    const breaker = { snapshot: () => ({ heygen: 'open' }) } as unknown as CircuitBreaker;

    sampleBreakers(metrics, breaker);

    const metric = metrics.registry.getSingleMetric('studio_provider_circuit_state');
    await expect(gaugeValue(metric as never, { provider: 'heygen' })).resolves.toBe(2);
  });

  it('sets one gauge per provider in the snapshot', async () => {
    const metrics = getMetrics();
    const breaker = {
      snapshot: () => ({ runway: 'closed', luma: 'open', elevenlabs: 'half_open' }),
    } as unknown as CircuitBreaker;

    sampleBreakers(metrics, breaker);

    const metric = metrics.registry.getSingleMetric('studio_provider_circuit_state');
    await expect(gaugeValue(metric as never, { provider: 'runway' })).resolves.toBe(0);
    await expect(gaugeValue(metric as never, { provider: 'luma' })).resolves.toBe(2);
    await expect(gaugeValue(metric as never, { provider: 'elevenlabs' })).resolves.toBe(1);
  });

  it('defaults an unrecognised breaker state to 0', async () => {
    const metrics = getMetrics();
    const breaker = {
      snapshot: () => ({ shotstack: 'unknown-state' }),
    } as unknown as CircuitBreaker;

    sampleBreakers(metrics, breaker);

    const metric = metrics.registry.getSingleMetric('studio_provider_circuit_state');
    await expect(gaugeValue(metric as never, { provider: 'shotstack' })).resolves.toBe(0);
  });
});

describe('sampleQueueDepths', () => {
  it('sets a gauge per queue and state from getJobCounts', async () => {
    queueCounts.set('studio-orchestration', { waiting: 3, active: 1, failed: 2 });
    const metrics = getMetrics();

    await sampleQueueDepths(metrics, {} as ConnectionOptions);

    const metric = metrics.registry.getSingleMetric('studio_queue_jobs');
    await expect(
      gaugeValue(metric as never, { queue: 'studio-orchestration', state: 'waiting' }),
    ).resolves.toBe(3);
    await expect(
      gaugeValue(metric as never, { queue: 'studio-orchestration', state: 'active' }),
    ).resolves.toBe(1);
    await expect(
      gaugeValue(metric as never, { queue: 'studio-orchestration', state: 'failed' }),
    ).resolves.toBe(2);
  });

  it('defaults a state missing from getJobCounts to zero', async () => {
    queueCounts.set('studio-assets', { waiting: 5 });
    const metrics = getMetrics();

    await sampleQueueDepths(metrics, {} as ConnectionOptions);

    const metric = metrics.registry.getSingleMetric('studio_queue_jobs');
    await expect(
      gaugeValue(metric as never, { queue: 'studio-assets', state: 'waiting' }),
    ).resolves.toBe(5);
    await expect(
      gaugeValue(metric as never, { queue: 'studio-assets', state: 'delayed' }),
    ).resolves.toBe(0);
    await expect(
      gaugeValue(metric as never, { queue: 'studio-assets', state: 'prioritized' }),
    ).resolves.toBe(0);
  });

  it('samples every configured queue', async () => {
    const metrics = getMetrics();

    await sampleQueueDepths(metrics, {} as ConnectionOptions);

    const metric = metrics.registry.getSingleMetric('studio_queue_jobs');
    for (const queue of [
      'studio-orchestration',
      'studio-assets',
      'studio-publish',
      'studio-scheduled',
      'studio-analytics',
      'studio-library',
    ]) {
      await expect(gaugeValue(metric as never, { queue, state: 'waiting' })).resolves.toBeDefined();
    }
  });
});
