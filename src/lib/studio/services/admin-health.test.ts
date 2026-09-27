import { describe, expect, it, vi } from 'vitest';
import { UpstreamServiceError } from '../../errors';
import { createCircuitBreaker, FAILURE_THRESHOLD } from '../providers/circuit-breaker';
import { createProviderRegistry } from '../providers/registry';
import type { ProviderAdapter } from '../providers/interface';
import { providerHealth, queueHealth, type InspectableQueue } from './admin-health';

// BACKLOG 13.16 — queue and provider health reports (pure parts; the routes are covered in
// test/api/admin-health.test.ts).

const NOW = Date.parse('2026-09-29T12:00:00Z');

function queue(
  name: string,
  counts: Record<string, number>,
  oldest: { wait?: number; prioritized?: number } = {},
): InspectableQueue {
  return {
    name,
    getJobCounts: vi.fn(async () => counts),
    getJobs: vi.fn(async (types: string[]) => {
      const stamp = types[0] === 'wait' ? oldest.wait : oldest.prioritized;
      return stamp === undefined ? [] : [{ timestamp: stamp }];
    }),
  };
}

describe('queueHealth', () => {
  it('adds prioritised to waiting and reports the oldest waiting job’s age', async () => {
    const report = await queueHealth(
      [
        queue(
          'studio-assets',
          { waiting: 10, prioritized: 4, active: 5, failed: 2, delayed: 0 },
          { wait: NOW - 41_000, prioritized: NOW - 12_000 },
        ),
        queue('studio-publish', { active: 1 }),
      ],
      NOW,
    );
    expect(report).toEqual([
      {
        name: 'studio-assets',
        waiting: 14,
        active: 5,
        failed: 2,
        delayed: 0,
        oldestWaitingSec: 41,
      },
      {
        name: 'studio-publish',
        waiting: 0,
        active: 1,
        failed: 0,
        delayed: 0,
        oldestWaitingSec: null,
      },
    ]);
  });

  it('answers 502 instead of hanging when Redis does not reply', async () => {
    const stuck: InspectableQueue = {
      name: 'studio-assets',
      getJobCounts: () => new Promise(() => undefined),
      getJobs: async () => [],
    };
    await expect(queueHealth([stuck], NOW, 20)).rejects.toBeInstanceOf(UpstreamServiceError);
  });
});

function adapter(providerId: string): ProviderAdapter {
  return {
    providerId,
    capabilities: ['text_to_video'],
    submit: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as ProviderAdapter;
}

describe('providerHealth', () => {
  it('joins breaker state, last-hour error rate (client errors excluded) and spend today', async () => {
    const breaker = createCircuitBreaker(() => NOW);
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) breaker.recordFailure('shotstack');
    const groupBy = vi.fn(async (args: { by: string[] }) =>
      args.by.includes('state')
        ? [
            { provider: 'runway', state: 'SUCCEEDED', errorClass: null, _count: { _all: 47 } },
            {
              provider: 'runway',
              state: 'FAILED',
              errorClass: 'provider_error',
              _count: { _all: 1 },
            },
            {
              provider: 'runway',
              state: 'FAILED',
              errorClass: 'content_policy',
              _count: { _all: 2 },
            },
            { provider: 'runway', state: 'RUNNING', errorClass: null, _count: { _all: 5 } },
            {
              provider: 'shotstack',
              state: 'TIMED_OUT',
              errorClass: 'timeout',
              _count: { _all: 7 },
            },
          ]
        : [{ provider: 'runway', _sum: { costPence: 1_840 } }],
    );
    const db = { providerJob: { groupBy }, providerUsage: { groupBy } };
    const report = await providerHealth(
      {
        db: db as never,
        registry: createProviderRegistry([
          adapter('runway'),
          adapter('shotstack'),
          adapter('luma'),
        ]),
        breaker,
      },
      NOW,
    );
    expect(report).toEqual([
      {
        id: 'luma',
        configured: true,
        breaker: 'closed',
        errorRate1h: null,
        jobs1h: { succeeded: 0, failed: 0, running: 0 },
        spendTodayPence: 0,
        healthy: true,
      },
      {
        id: 'runway',
        configured: true,
        breaker: 'closed',
        errorRate1h: 0.02,
        jobs1h: { succeeded: 47, failed: 3, running: 5 },
        spendTodayPence: 1_840,
        healthy: true,
      },
      {
        id: 'shotstack',
        configured: true,
        breaker: 'open',
        errorRate1h: 1,
        jobs1h: { succeeded: 0, failed: 7, running: 0 },
        spendTodayPence: 0,
        healthy: false,
      },
    ]);
    const where = (groupBy.mock.calls[0]?.[0] as unknown as { where: { startedAt: { gte: Date } } })
      .where;
    expect(where.startedAt.gte.toISOString()).toBe('2026-09-29T11:00:00.000Z');
  });

  it('lists a provider that ran but is no longer configured as unhealthy', async () => {
    const groupBy = vi.fn(async (args: { by: string[] }) =>
      args.by.includes('state')
        ? [{ provider: 'pika', state: 'SUCCEEDED', errorClass: null, _count: { _all: 1 } }]
        : [],
    );
    const [pika] = await providerHealth(
      {
        db: { providerJob: { groupBy }, providerUsage: { groupBy } } as never,
        registry: createProviderRegistry([]),
        breaker: createCircuitBreaker(() => NOW),
      },
      NOW,
    );
    expect(pika).toMatchObject({ id: 'pika', configured: false, healthy: false, errorRate1h: 0 });
  });
});
