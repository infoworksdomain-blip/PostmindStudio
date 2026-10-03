import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, RateDeferredError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import { InlineJobQueue } from './enqueue';
import {
  deferralFor,
  deferralsOf,
  MAX_RATE_DEFERRALS,
  RATE_BACKOFF_CAP_MS,
  rateBackoffMs,
} from './rate-deferral';
import { drainInline, executeJob, FAILURE_HANDLERS, PROCESSORS } from './workers/runtime';

// 20.29: a provider's "too many requests" delays the job (no attempt spent), bounded.

const busy = () => new ProviderError('seedance', 'rate_limited', '429 Too Many Requests', true);

describe('rate deferral policy', () => {
  it('backs off exponentially with jitter, capped at two minutes', () => {
    expect(rateBackoffMs(0, () => 0.5)).toBe(10_000);
    expect(rateBackoffMs(1, () => 0.5)).toBe(20_000);
    expect(rateBackoffMs(3, () => 0.5)).toBe(80_000);
    expect(rateBackoffMs(9, () => 0.5)).toBe(RATE_BACKOFF_CAP_MS);
    expect(rateBackoffMs(0, () => 0)).toBe(7_500);
    expect(rateBackoffMs(0, () => 1)).toBe(12_500);
  });

  it('defers a provider rate limit until the deferral budget is spent', () => {
    const first = deferralFor(busy(), 0, () => 0.5);
    expect(first).toBeInstanceOf(RateDeferredError);
    expect(first).toMatchObject({
      providerId: 'seedance',
      retryAfterMs: 10_000,
      details: expect.objectContaining({ reason: 'provider_rate_limited', deferrals: 1 }),
    });
    expect(deferralFor(busy(), MAX_RATE_DEFERRALS - 1)).toBeInstanceOf(RateDeferredError);
    expect(deferralFor(busy(), MAX_RATE_DEFERRALS)).toBeUndefined();
  });

  it('passes rate windows and concurrency caps through, and ignores other errors', () => {
    const window = new RateDeferredError('kling', 3_000, { reason: 'provider_full' });
    expect(deferralFor(window, 500)).toBe(window);
    expect(deferralFor(new ProviderError('kling', 'timeout', 'slow', true), 0)).toBeUndefined();
    expect(deferralFor(new Error('db blip'), 0)).toBeUndefined();
  });

  it('counts BullMQ deferrals from attemptsStarted − attemptsMade', () => {
    expect(deferralsOf({ attemptsStarted: 1, attemptsMade: 0 })).toBe(0);
    expect(deferralsOf({ attemptsStarted: 4, attemptsMade: 0 })).toBe(3);
    expect(deferralsOf({ attemptsStarted: 4, attemptsMade: 2 })).toBe(1);
    expect(deferralsOf({ attemptsMade: 0 })).toBe(0);
  });
});

describe('executeJob with a busy provider (20.29)', () => {
  afterEach(() => vi.restoreAllMocks());

  const data = { projectId: 'p', organisationId: 'o', runId: 'r', planTier: 'BASIC' as const };
  function deps(executeRaw = vi.fn(async () => 1)) {
    return {
      logger: pino({ level: 'silent' }),
      killSwitch: { assertNotKilled: vi.fn(async () => undefined) },
      db: { $executeRaw: executeRaw },
      now: () => Date.parse('2026-10-03T12:00:00Z'),
    } as unknown as PipelineDeps;
  }

  it('turns a 429 into a deferral, records the wait on the project and skips the failure handler', async () => {
    vi.spyOn(PROCESSORS, 'compose-video').mockRejectedValue(busy());
    const handler = vi.spyOn(FAILURE_HANDLERS, 'compose-video').mockResolvedValue();
    const executeRaw = vi.fn(async () => 1);
    const err = await executeJob('compose-video', data, deps(executeRaw), {
      attemptsMade: 5,
      maxAttempts: 6,
      deferrals: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateDeferredError);
    expect(handler).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(JSON.stringify(executeRaw.mock.calls[0])).toContain('providerWait');
  });

  it('fails normally once the deferral budget is spent', async () => {
    vi.spyOn(PROCESSORS, 'compose-video').mockRejectedValue(busy());
    const handler = vi.spyOn(FAILURE_HANDLERS, 'compose-video').mockResolvedValue();
    const err = await executeJob('compose-video', data, deps(), {
      attemptsMade: 5,
      maxAttempts: 6,
      deferrals: MAX_RATE_DEFERRALS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('still defers when the provider wait cannot be recorded', async () => {
    vi.spyOn(PROCESSORS, 'compose-video').mockRejectedValue(busy());
    const failing = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      executeJob('compose-video', data, deps(failing), { attemptsMade: 0, maxAttempts: 6 }),
    ).rejects.toBeInstanceOf(RateDeferredError);
  });

  it('drainInline waits out deferrals without spending attempts', async () => {
    let calls = 0;
    vi.spyOn(PROCESSORS, 'compose-video').mockImplementation(async () => {
      calls += 1;
      if (calls <= 3) throw busy();
    });
    const queue = new InlineJobQueue();
    await queue.add('compose-video', data);
    const sleep = vi.fn(async () => undefined);
    const result = await drainInline(queue, { ...deps(), sleep } as unknown as PipelineDeps, {
      maxAttempts: 1,
    });
    expect(result.failedJobs).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
