import { DelayedError } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, RateDeferredError } from '../../errors';
import { deferIfRateLimited } from '../queue/worker-host';
import {
  ACQUIRE_SCRIPT,
  createMemoryProviderRateLimiter,
  createRedisProviderRateLimiter,
  parseRateLimit,
  providerRateLimiterFromEnv,
  RATE_KEY_PREFIX,
  rateEnvName,
  rateLimitsFromEnv,
} from './provider-rate';

// 15.C3 — sliding-window provider rate coordination (spec 11.4). The Lua window runs against a
// real Redis when REDIS_URL is set (CI); the rest needs none.

const logger = { warn: vi.fn() };

describe('rate limit configuration', () => {
  it('names the env var after the provider id', () => {
    expect(rateEnvName('pexels-video')).toBe('STUDIO_PROVIDER_RATE_PEXELS_VIDEO');
  });

  it('parses provider and organisation windows', () => {
    expect(parseRateLimit('200/3600,org=50/60')).toEqual({
      provider: { max: 200, windowMs: 3_600_000 },
      organisation: { max: 50, windowMs: 60_000 },
    });
    expect(parseRateLimit('org=5/1')).toEqual({ organisation: { max: 5, windowMs: 1_000 } });
    expect(() => parseRateLimit('lots')).toThrow(ConfigurationError);
    expect(() => parseRateLimit('0/10')).toThrow(ConfigurationError);
    expect(() => parseRateLimit(' , ')).toThrow(ConfigurationError);
  });

  it('reads limits lazily per provider', () => {
    const limits = rateLimitsFromEnv({ STUDIO_PROVIDER_RATE_RUNWAY: '10/60' });
    expect(limits('runway')).toEqual({ provider: { max: 10, windowMs: 60_000 } });
    expect(limits('luma')).toBeUndefined();
  });

  it('builds a limiter only with Redis and at least one limit', () => {
    const client = { eval: vi.fn() };
    expect(providerRateLimiterFromEnv({}, () => client, logger)).toBeUndefined();
    expect(
      providerRateLimiterFromEnv({ STUDIO_PROVIDER_RATE_X: '1/1' }, () => client, logger),
    ).toBeUndefined();
    expect(
      providerRateLimiterFromEnv(
        { STUDIO_PROVIDER_RATE_X: '1/1', REDIS_URL: 'redis://x' },
        () => client,
        logger,
      ),
    ).toBeDefined();
  });
});

describe('memory limiter (same algorithm as the Lua script)', () => {
  it('enforces the organisation share and the provider-wide window', async () => {
    let t = 0;
    const limiter = createMemoryProviderRateLimiter(
      () => ({ provider: { max: 3, windowMs: 1_000 }, organisation: { max: 2, windowMs: 1_000 } }),
      () => t,
    );
    const a = { providerId: 'runway', organisationId: 'org-a' };
    const b = { providerId: 'runway', organisationId: 'org-b' };
    expect(await limiter.acquire(a)).toEqual({ allowed: true });
    t = 100;
    expect(await limiter.acquire(a)).toEqual({ allowed: true });
    // org-a used its share: wait until its oldest call leaves the window
    expect(await limiter.acquire(a)).toEqual({ allowed: false, retryAfterMs: 900 });
    expect(await limiter.acquire(b)).toEqual({ allowed: true });
    // provider-wide window full for everyone
    expect(await limiter.acquire(b)).toEqual({ allowed: false, retryAfterMs: 900 });
    t = 1_001;
    expect(await limiter.acquire(a)).toEqual({ allowed: true });
  });

  it('never limits an unconfigured provider', async () => {
    const limiter = createMemoryProviderRateLimiter(() => undefined);
    expect(await limiter.acquire({ providerId: 'x', organisationId: 'o' })).toEqual({
      allowed: true,
    });
  });
});

describe('redis limiter', () => {
  it('passes both keys and limits to the script and reports a delay', async () => {
    const client = { eval: vi.fn(async () => 250) };
    const limiter = createRedisProviderRateLimiter({
      client,
      limits: () => ({ organisation: { max: 1, windowMs: 1_000 } }),
      logger,
      now: () => 5,
    });
    expect(await limiter.acquire({ providerId: 'luma', organisationId: 'org-1' })).toEqual({
      allowed: false,
      retryAfterMs: 250,
    });
    const args = client.eval.mock.calls[0] as unknown as string[];
    expect(args.slice(1, 4)).toEqual([
      2,
      `${RATE_KEY_PREFIX}luma`,
      `${RATE_KEY_PREFIX}luma:org-1`,
    ] as unknown as string[]);
    expect(args.slice(6)).toEqual(['0', '0', '1', '1000']);
  });

  it('fails open (and warns once a minute) when Redis errors', async () => {
    const warn = vi.fn();
    const limiter = createRedisProviderRateLimiter({
      client: { eval: async () => Promise.reject(new Error('ECONNREFUSED')) },
      limits: () => ({ provider: { max: 1, windowMs: 1_000 } }),
      logger: { warn },
      now: () => 0,
    });
    const input = { providerId: 'p', organisationId: 'o' };
    expect(await limiter.acquire(input)).toEqual({ allowed: true });
    expect(await limiter.acquire(input)).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!process.env.REDIS_URL)('Lua sliding window on Redis', () => {
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : undefined;
  afterAll(() => redis?.disconnect());

  it('admits up to max per window, then returns the wait', async () => {
    const provider = `${RATE_KEY_PREFIX}test-${randomUUID()}`;
    const org = `${provider}:org`;
    const run = (now: number) =>
      redis!.eval(
        ACQUIRE_SCRIPT,
        2,
        provider,
        org,
        String(now),
        randomUUID(),
        '2',
        '1000',
        '0',
        '0',
      );
    expect(await run(0)).toBe(0);
    expect(await run(10)).toBe(0);
    expect(await run(20)).toBe(980);
    expect(await run(1_001)).toBe(0);
    await redis!.del(provider, org);
  });
});

describe('worker deferral (BullMQ moveToDelayed)', () => {
  it('delays a rate-deferred job without spending an attempt', async () => {
    const job = { moveToDelayed: vi.fn(async () => undefined) };
    await expect(
      deferIfRateLimited(new RateDeferredError('runway', 4_000), job, 'tok', () => 1_000),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(5_000, 'tok');
  });

  it('leaves every other error alone', async () => {
    const job = { moveToDelayed: vi.fn(async () => undefined) };
    await deferIfRateLimited(new Error('boom'), job, 'tok', () => 0);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
