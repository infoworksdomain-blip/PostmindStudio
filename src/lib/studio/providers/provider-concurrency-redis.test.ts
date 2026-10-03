import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { redisConnectionFromUrl } from '../queue/redis';
import { createBreakerRedisClient } from './circuit-breaker-redis';
import {
  CONCURRENCY_KEY_PREFIX,
  createRedisProviderConcurrencyLimiter,
  SLOT_RETRY_MS,
} from './provider-concurrency';

// 20.29: the acquire / release scripts on real Redis (CI's Redis 7; skipped without REDIS_URL).

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('provider concurrency slots in Redis', () => {
  const connection = redisUrl ? redisConnectionFromUrl(redisUrl) : undefined;
  const provider = `test-${randomUUID()}`;
  const clients: Redis[] = [];

  async function limiter(now: () => number = Date.now) {
    const client = createBreakerRedisClient(connection as never);
    clients.push(client);
    if (client.status !== 'ready') await new Promise((resolve) => client.once('ready', resolve));
    return createRedisProviderConcurrencyLimiter({
      client,
      limits: () => ({ max: 2, perOrganisation: 1 }),
      logger: { warn: () => undefined },
      now,
      random: () => 0,
    });
  }

  afterAll(async () => {
    const admin = new Redis(connection as never);
    const keys = await admin.keys(`${CONCURRENCY_KEY_PREFIX}${provider}*`);
    if (keys.length) await admin.del(...keys);
    await admin.quit();
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('shares the cap and the organisation share between processes, and counts waiters', async () => {
    const a = await limiter();
    const b = await limiter();
    const take = (l: typeof a, org: string, waiterId: string) =>
      l.acquire({ providerId: provider, organisationId: org, leaseMs: 60_000, waiterId });

    const first = await take(a, 'heavy', 'h1');
    expect(first.acquired).toBe(true);
    expect(await take(b, 'heavy', 'h2')).toMatchObject({
      acquired: false,
      reason: 'organisation_share',
    });
    const second = await take(b, 'light', 'l1');
    expect(second.acquired).toBe(true);
    expect(await take(a, 'other', 'o1')).toMatchObject({
      acquired: false,
      reason: 'provider_full',
      retryAfterMs: SLOT_RETRY_MS,
    });

    if (first.acquired) await first.release();
    // h2 is still waiting (counted), o1 takes the freed slot and stops waiting.
    expect((await take(b, 'other', 'o1')).acquired).toBe(true);
    const admin = new Redis(connection as never);
    expect(await admin.zrange(`${CONCURRENCY_KEY_PREFIX}${provider}:waiting`, 0, -1)).toEqual([
      'h2',
    ]);
    await admin.quit();
  });

  it('frees a slot whose lease expired (a worker died mid-job)', async () => {
    let t = Date.now();
    const l = await limiter(() => t);
    const p = `${provider}-lease`;
    const take = (org: string) => l.acquire({ providerId: p, organisationId: org, leaseMs: 1_000 });
    expect((await take('a')).acquired).toBe(true);
    expect((await take('b')).acquired).toBe(true);
    expect((await take('c')).acquired).toBe(false);
    t += 1_001;
    expect((await take('c')).acquired).toBe(true);
  });
});
