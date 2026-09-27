import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { redisConnectionFromUrl } from '../queue/redis';
import {
  createCircuitBreaker,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  OPEN_DURATION_MS,
  TRIAL_TIMEOUT_MS,
} from './circuit-breaker';
import {
  BREAKER_KEY_PREFIX,
  breakerStoreFromEnv,
  createBreakerRedisClient,
  createRedisCircuitBreaker,
  type BreakerRedisClient,
} from './circuit-breaker-redis';

// BACKLOG 13.16 — the shared (Redis) circuit breaker. The fail-safe tests need no Redis; the
// shared-state tests run against a real Redis when REDIS_URL is set (CI; locally Redis 3.0 works).

const logger = pino({ level: 'silent' });

function downClient(): BreakerRedisClient {
  const fail = () => Promise.reject(new Error('ECONNREFUSED'));
  return { eval: fail, hget: fail, hdel: fail, del: fail, sadd: fail, smembers: fail };
}

describe('breakerStoreFromEnv', () => {
  it('defaults to redis when REDIS_URL is set, memory otherwise', () => {
    expect(breakerStoreFromEnv({ REDIS_URL: 'redis://x:6379/3' })).toBe('redis');
    expect(breakerStoreFromEnv({})).toBe('memory');
  });

  it('honours an explicit store and rejects anything else', () => {
    expect(
      breakerStoreFromEnv({ REDIS_URL: 'redis://x', STUDIO_CIRCUIT_BREAKER_STORE: 'memory' }),
    ).toBe('memory');
    expect(breakerStoreFromEnv({ STUDIO_CIRCUIT_BREAKER_STORE: 'REDIS' })).toBe('redis');
    expect(() => breakerStoreFromEnv({ STUDIO_CIRCUIT_BREAKER_STORE: 'etcd' })).toThrow(
      /must be "redis" or "memory"/,
    );
  });
});

describe('fail-safe while Redis is down', () => {
  it('falls back to this process’s breaker: still trips after 5 failures, then half-opens', async () => {
    let t = 1_000;
    const warn = vi.fn();
    const breaker = createRedisCircuitBreaker({
      client: downClient(),
      now: () => t,
      logger: { ...logger, warn } as unknown as typeof logger,
    });
    expect(await breaker.tryAcquire('runway')).toBe(true);
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) await breaker.recordFailure('runway');
    expect(await breaker.state('runway')).toBe('open');
    expect(await breaker.tryAcquire('runway')).toBe(false);
    expect(await breaker.snapshot()).toEqual({ runway: 'open' });
    t += OPEN_DURATION_MS;
    expect(await breaker.tryAcquire('runway')).toBe(true);
    await breaker.recordSuccess('runway');
    expect(await breaker.state('runway')).toBe('closed');
    // Warned at most once a minute, not per call: once before and once after the 5 minutes.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('mirrors outcomes into the local breaker even while Redis answers', async () => {
    const local = createCircuitBreaker(() => 0);
    const client: BreakerRedisClient = {
      eval: vi.fn(async () => 0),
      hget: vi.fn(async () => null),
      hdel: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => []),
    };
    const breaker = createRedisCircuitBreaker({ client, now: () => 0, logger, fallback: local });
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) await breaker.recordFailure('luma');
    expect(local.state('luma')).toBe('open');
    // Redis (the shared state) said closed: that is what callers see.
    expect(await breaker.state('luma')).toBe('closed');
    expect(client.eval).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
  });
});

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('shared state in Redis', () => {
  const connection = redisUrl ? redisConnectionFromUrl(redisUrl) : undefined;
  const clients: Redis[] = [];
  const provider = `test-${randomUUID()}`;

  /** A breaker as one process sees it, once its fail-fast client has connected. */
  async function processBreaker(now: () => number) {
    const client = createBreakerRedisClient(connection as never);
    clients.push(client);
    if (client.status !== 'ready') await new Promise((resolve) => client.once('ready', resolve));
    return createRedisCircuitBreaker({ client, now, logger });
  }

  afterAll(async () => {
    const admin = new Redis(connection as never);
    await admin.del(
      `${BREAKER_KEY_PREFIX}${provider}`,
      `${BREAKER_KEY_PREFIX}${provider}:failures`,
    );
    await admin.srem(`${BREAKER_KEY_PREFIX}providers`, provider);
    await admin.quit();
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('one process’s failures open the breaker for every process, with one trial', async () => {
    let t = Date.now();
    const clock = () => t;
    const a = await processBreaker(clock);
    const b = await processBreaker(clock);

    for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) await a.recordFailure(provider);
    expect(await b.state(provider)).toBe('closed');
    await b.recordFailure(provider);
    expect(await a.state(provider)).toBe('open');
    expect(await b.tryAcquire(provider)).toBe(false);
    expect((await a.snapshot())[provider]).toBe('open');

    t += OPEN_DURATION_MS;
    expect(await a.tryAcquire(provider)).toBe(true);
    expect(await b.tryAcquire(provider)).toBe(false); // the single platform-wide trial
    await a.releaseTrial(provider);
    expect(await b.tryAcquire(provider)).toBe(true);
    await b.recordFailure(provider); // trial failed → open again
    expect(await a.state(provider)).toBe('open');

    t += OPEN_DURATION_MS + TRIAL_TIMEOUT_MS;
    expect(await a.tryAcquire(provider)).toBe(true);
    await a.recordSuccess(provider);
    expect(await b.state(provider)).toBe('closed');
  });

  it('forgets failures outside the 60 s window', async () => {
    let t = Date.now();
    const a = await processBreaker(() => t);
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) await a.recordFailure(provider);
    t += FAILURE_WINDOW_MS + 1;
    await a.recordFailure(provider);
    expect(await a.state(provider)).toBe('closed');
  });
});
