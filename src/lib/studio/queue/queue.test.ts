import { UnrecoverableError } from 'bullmq';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  NotFoundError,
  NotImplementedError,
  ProviderError,
  ValidationError,
} from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import { InlineJobQueue, jobIds } from './enqueue';
import {
  DEFAULT_JOB_OPTIONS,
  JOB_QUEUE,
  jobPriority,
  priorityFor,
  PRIORITY,
  QUEUES,
  retryDelayMs,
} from './queues';
import { queuePrefix, redisConnectionFromUrl } from './redis';
import {
  concurrencyFor,
  DEFAULT_CONCURRENCY,
  PIPELINE_QUEUES,
  withRenderLane,
} from './worker-host';
import {
  describeError,
  drainInline,
  executeJob,
  FAILURE_HANDLERS,
  isRetryable,
  PROCESSORS,
} from './workers/runtime';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('redis connection (DB 3)', () => {
  it('parses REDIS_URL and forces BullMQ-safe options', () => {
    expect(redisConnectionFromUrl('redis://user:p%40ss@cache:6380/3')).toEqual({
      host: 'cache',
      port: 6380,
      db: 3,
      username: 'user',
      password: 'p@ss',
      maxRetriesPerRequest: null,
    });
    expect(redisConnectionFromUrl('rediss://cache')).toMatchObject({ db: 3, port: 6379, tls: {} });
  });

  it.each(['redis://cache/0', 'http://cache/3', 'not a url'])('rejects %s', (url) => {
    expect(() => redisConnectionFromUrl(url)).toThrow(ConfigurationError);
  });

  it('uses the configured queue prefix', () => {
    expect(queuePrefix()).toBe('studio');
    vi.stubEnv('BULLMQ_QUEUE_PREFIX', 'studio-staging');
    expect(queuePrefix()).toBe('studio-staging');
  });
});

describe('queue policy (spec 11)', () => {
  it('routes jobs to the spec queues', () => {
    expect(JOB_QUEUE['plan-project']).toBe(QUEUES.orchestration);
    expect(JOB_QUEUE['generate-asset']).toBe(QUEUES.assets);
    expect(JOB_QUEUE['run-quality-gate']).toBe(QUEUES.orchestration);
  });

  it('23.6: renders run on their own lane; planning and the runners stay on orchestration', () => {
    for (const name of ['compose-video', 'poll-render', 'render-carousel'] as const)
      expect(JOB_QUEUE[name]).toBe(QUEUES.render);
    for (const name of [
      'plan-project',
      'draft-content-plan',
      'advance-content-plans',
      'advance-automations',
      'refill-blitz-queue',
    ] as const)
      expect(JOB_QUEUE[name]).toBe(QUEUES.orchestration);
    expect(DEFAULT_CONCURRENCY[QUEUES.render]).toBe(3);
    expect(concurrencyFor(QUEUES.render, { WORKER_CONCURRENCY_RENDER: '5' })).toBe(5);
    expect(PIPELINE_QUEUES).toContain(QUEUES.render);
  });

  it('23.6: a worker listing orchestration also takes the render lane unless separated', () => {
    expect(withRenderLane([QUEUES.orchestration, QUEUES.assets], {})).toEqual([
      QUEUES.orchestration,
      QUEUES.assets,
      QUEUES.render,
    ]);
    expect(withRenderLane([QUEUES.assets], {})).toEqual([QUEUES.assets]);
    expect(withRenderLane([QUEUES.orchestration, QUEUES.render], {})).toHaveLength(2);
    expect(withRenderLane([QUEUES.orchestration], { STUDIO_RENDER_LANE: 'separate' })).toEqual([
      QUEUES.orchestration,
    ]);
  });

  it('23.6: the plan, automation and Blitz runners run at high priority', () => {
    const data = { organisationId: 'o', runId: 'r', planTier: 'STANDARD' as const };
    expect(jobPriority('advance-content-plans', data)).toBe(PRIORITY.high);
    expect(jobPriority('advance-automations', data)).toBe(PRIORITY.high);
    expect(jobPriority('plan-project', { ...data, batch: true })).toBe(PRIORITY.low);
    expect(jobPriority('plan-project', data)).toBe(PRIORITY.normal);
  });

  it('23.6: drainInline waits out a render poll delay; promote runs it at once', async () => {
    const queue = new InlineJobQueue();
    const data = { projectId: 'p', organisationId: 'o', runId: 'r', planTier: 'STANDARD' as const };
    await queue.add(
      'poll-render',
      { ...data, chain: 'c', poll: 1 },
      { jobId: 'a', delayMs: 20_000 },
    );
    expect(queue.pending[0]?.delayMs).toBe(20_000);
    expect(await queue.promote('poll-render', 'a')).toBe(true);
    expect(queue.pending[0]?.delayMs).toBeUndefined();
    expect(await queue.promote('poll-render', 'a')).toBe(false);
    const slept: number[] = [];
    vi.spyOn(PROCESSORS, 'poll-render').mockResolvedValue();
    await queue.add(
      'poll-render',
      { ...data, chain: 'c', poll: 2 },
      { jobId: 'b', delayMs: 5_000 },
    );
    queue.take(); // 'a' (promoted) is not delayed
    await drainInline(queue, {
      logger: pino({ level: 'silent' }),
      killSwitch: { assertNotKilled: vi.fn(async () => undefined) },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    } as unknown as PipelineDeps);
    expect(slept).toEqual([5_000]);
  });

  it('retries 5 times with 5s→2min exponential backoff and keeps failures', () => {
    // 23.6: failures stay for operator action, capped per queue; successes kept 6 h / 1 000.
    expect(DEFAULT_JOB_OPTIONS).toMatchObject({
      attempts: 6,
      removeOnComplete: { age: 6 * 60 * 60, count: 1_000 },
      removeOnFail: { count: 5_000 },
    });
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([
      5000, 10000, 20000, 40000, 80000, 120000, 120000,
    ]);
  });

  it('prioritises paid tiers and demotes batch work', () => {
    expect(priorityFor('ENTERPRISE')).toBe(PRIORITY.high);
    expect(priorityFor('PLUS')).toBe(PRIORITY.high);
    expect(priorityFor('STANDARD')).toBe(PRIORITY.normal);
    expect(priorityFor('BASIC')).toBe(PRIORITY.normal);
    expect(priorityFor('ENTERPRISE', true)).toBe(PRIORITY.low);
  });

  it('builds deterministic, BullMQ-safe job ids', () => {
    const data = {
      projectId: 'p',
      organisationId: 'o',
      runId: 'r',
      planTier: 'BASIC' as const,
      publicationId: 'pub',
    };
    expect(jobIds.planProject(data)).toBe('plan-project__p__r');
    expect(jobIds.publishVideo(data, 2)).toBe('publish-video__pub__2');
    expect(jobIds.fireScheduled(data)).toBe('fire-scheduled__pub');
    expect(jobIds.generateAsset({ ...data, shotId: 's' })).toBe('generate-asset__s__r');
    const business = {
      organisationId: 'o',
      businessId: 'b',
      runId: 'r2',
      planTier: 'BASIC' as const,
    };
    expect(jobIds.scanWebsite({ ...business, scanId: 'sc' })).toBe('scan-website__sc');
    expect(jobIds.refreshImageLibrary(business)).toBe('refresh-image-library__b__r2');
    const all = { ...data, shotId: 's', scanId: 'sc', businessId: 'b' };
    expect(
      Object.values(jobIds).every((f) => !(f as (d: typeof all) => string)(all).includes(':')),
    ).toBe(true);
  });

  it('reads worker concurrency from env with spec defaults', () => {
    expect(concurrencyFor(QUEUES.assets, {})).toBe(DEFAULT_CONCURRENCY[QUEUES.assets]);
    expect(concurrencyFor(QUEUES.assets, { WORKER_CONCURRENCY_ASSETS: '3' })).toBe(3);
    expect(concurrencyFor(QUEUES.assets, { WORKER_CONCURRENCY_ASSETS: 'x' })).toBe(15);
  });
});

describe('InlineJobQueue', () => {
  it('deduplicates by jobId like BullMQ', async () => {
    const queue = new InlineJobQueue();
    const data = { projectId: 'p', organisationId: 'o', runId: 'r', planTier: 'BASIC' as const };
    await queue.add('compose-video', data, { jobId: 'x' });
    await queue.add('compose-video', data, { jobId: 'x' });
    await queue.add('compose-video', data);
    expect(queue.history).toHaveLength(2);
    expect(queue.take()?.jobId).toBe('x');
  });
});

describe('job runtime (BACKLOG 3.8 / 3.9)', () => {
  it.each([
    [new ProviderError('r', 'rate_limited', 'x', true), true],
    [new ProviderError('r', 'invalid_request', 'x', false), false],
    [new NoProviderAvailableError('x'), true],
    [new KillSwitchTriggeredError('global', 'x'), false],
    [new ValidationError('x'), false],
    [new NotFoundError('x'), false],
    [new NotImplementedError('x'), false],
    [new ConfigurationError('x'), false],
    [new Error('db blip'), true],
  ])('isRetryable(%o) = %s', (err, expected) => {
    expect(isRetryable(err)).toBe(expected);
  });

  it('describes errors for failure reasons', () => {
    expect(describeError(new KillSwitchTriggeredError('workspace', 'frozen'))).toBe(
      'kill_switch_workspace: frozen',
    );
    expect(describeError(new ProviderError('runway', 'timeout', 'slow', true))).toBe(
      'runway/timeout: slow',
    );
    expect(describeError('x')).toBe('x');
  });

  function deps(killed = false) {
    return {
      logger: pino({ level: 'silent' }),
      killSwitch: {
        assertNotKilled: vi.fn(async () => {
          if (killed) throw new KillSwitchTriggeredError('global', 'stopped');
        }),
      },
    } as unknown as PipelineDeps;
  }
  const data = { projectId: 'p', organisationId: 'o', runId: 'r', planTier: 'BASIC' as const };

  it('checks the kill switch before processing and fails the run unrecoverably', async () => {
    const processor = vi.spyOn(PROCESSORS, 'compose-video').mockResolvedValue();
    const handler = vi.spyOn(FAILURE_HANDLERS, 'compose-video').mockResolvedValue();
    await expect(
      executeJob('compose-video', data, deps(true), { attemptsMade: 0, maxAttempts: 6 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(processor).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      data,
      expect.anything(),
      'kill_switch_global: stopped',
      expect.any(KillSwitchTriggeredError),
    );
  });

  it('rethrows retryable errors without the failure handler until the last attempt', async () => {
    vi.spyOn(PROCESSORS, 'compose-video').mockRejectedValue(new Error('blip'));
    const handler = vi.spyOn(FAILURE_HANDLERS, 'compose-video').mockResolvedValue();
    await expect(
      executeJob('compose-video', data, deps(), { attemptsMade: 0, maxAttempts: 6 }),
    ).rejects.toThrow('blip');
    expect(handler).not.toHaveBeenCalled();
    await expect(
      executeJob('compose-video', data, deps(), { attemptsMade: 5, maxAttempts: 6 }),
    ).rejects.toThrow('blip');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('survives a failing failure handler', async () => {
    vi.spyOn(PROCESSORS, 'compose-video').mockRejectedValue(new ValidationError('bad'));
    vi.spyOn(FAILURE_HANDLERS, 'compose-video').mockRejectedValue(new Error('db down'));
    await expect(
      executeJob('compose-video', data, deps(), { attemptsMade: 0, maxAttempts: 6 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('succeeds quietly', async () => {
    vi.spyOn(PROCESSORS, 'compose-video').mockResolvedValue();
    await expect(
      executeJob('compose-video', data, deps(), { attemptsMade: 0, maxAttempts: 6 }),
    ).resolves.toBeUndefined();
  });
});
