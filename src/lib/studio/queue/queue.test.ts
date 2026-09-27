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
  priorityFor,
  PRIORITY,
  QUEUES,
  retryDelayMs,
} from './queues';
import { queuePrefix, redisConnectionFromUrl } from './redis';
import { concurrencyFor, DEFAULT_CONCURRENCY } from './worker-host';
import {
  describeError,
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

  it('retries 5 times with 5s→2min exponential backoff and keeps failures', () => {
    expect(DEFAULT_JOB_OPTIONS).toMatchObject({ attempts: 6, removeOnFail: false });
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
    const data = { projectId: 'p', organisationId: 'o', runId: 'r', planTier: 'BASIC' as const };
    expect(jobIds.planProject(data)).toBe('plan-project__p__r');
    expect(jobIds.generateAsset({ ...data, shotId: 's' })).toBe('generate-asset__s__r');
    expect(Object.values(jobIds).every((f) => !f({ ...data, shotId: 's' }).includes(':'))).toBe(
      true,
    );
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
    expect(handler).toHaveBeenCalledWith(data, expect.anything(), 'kill_switch_global: stopped');
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
