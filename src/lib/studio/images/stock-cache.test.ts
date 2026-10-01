import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryStockCache,
  createRedisStockCache,
  resetStockCacheForTests,
  STOCK_CACHE_KEY_PREFIX,
  STOCK_CACHE_TTL_MS,
  stockCacheFromEnv,
  type StockCacheRedisClient,
} from './stock-cache';

// 20.16 — the 24 h stock search cache (Pixabay: "Requests must be cached for 24 hours").

afterEach(() => resetStockCacheForTests());

function fakeRedis(fail = false) {
  const store = new Map<string, string>();
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const client: StockCacheRedisClient = {
    async get(key) {
      calls.push({ op: 'get', args: [key] });
      if (fail) throw new Error('ECONNREFUSED');
      return store.get(key) ?? null;
    },
    async set(key, value, mode, ttl) {
      calls.push({ op: 'set', args: [key, value, mode, ttl] });
      if (fail) throw new Error('ECONNREFUSED');
      store.set(key, value);
      return 'OK';
    },
  };
  return { client, store, calls };
}

describe('createMemoryStockCache', () => {
  it('returns a value until its TTL passes', async () => {
    let t = 0;
    const cache = createMemoryStockCache({ now: () => t });
    await cache.set('a', '1', STOCK_CACHE_TTL_MS);
    t = STOCK_CACHE_TTL_MS - 1;
    await expect(cache.get('a')).resolves.toBe('1');
    t = STOCK_CACHE_TTL_MS;
    await expect(cache.get('a')).resolves.toBeNull();
  });

  it('evicts the least recently used entry beyond maxEntries', async () => {
    const cache = createMemoryStockCache({ maxEntries: 2 });
    await cache.set('a', '1', 60_000);
    await cache.set('b', '2', 60_000);
    await cache.get('a'); // a is now the most recently used
    await cache.set('c', '3', 60_000);
    await expect(cache.get('b')).resolves.toBeNull();
    await expect(cache.get('a')).resolves.toBe('1');
    await expect(cache.get('c')).resolves.toBe('3');
  });

  it('a second set replaces the value', async () => {
    const cache = createMemoryStockCache();
    await cache.set('a', '1', 60_000);
    await cache.set('a', '2', 60_000);
    await expect(cache.get('a')).resolves.toBe('2');
  });
});

describe('createRedisStockCache', () => {
  const logger = () => ({ warn: vi.fn() });

  it('stores under the studio:stockcache: prefix with a PX expiry', async () => {
    const redis = fakeRedis();
    const cache = createRedisStockCache({
      client: redis.client,
      fallback: createMemoryStockCache(),
      logger: logger(),
    });
    await cache.set('pixabay:abc', '[]', STOCK_CACHE_TTL_MS);
    expect(redis.calls[0]).toEqual({
      op: 'set',
      args: [`${STOCK_CACHE_KEY_PREFIX}pixabay:abc`, '[]', 'PX', STOCK_CACHE_TTL_MS],
    });
    await expect(cache.get('pixabay:abc')).resolves.toBe('[]');
    await expect(cache.get('pixabay:other')).resolves.toBeNull();
  });

  it('falls back to the in-process cache when Redis fails, warning at most once a minute', async () => {
    let t = 0;
    const log = logger();
    const cache = createRedisStockCache({
      client: fakeRedis(true).client,
      fallback: createMemoryStockCache({ now: () => t }),
      logger: log,
      now: () => t,
    });
    await cache.set('k', 'v', 60_000);
    await expect(cache.get('k')).resolves.toBe('v');
    expect(log.warn).toHaveBeenCalledTimes(1);
    t = 60_000;
    await cache.get('k');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe('stockCacheFromEnv', () => {
  it('uses Redis when REDIS_URL is set, and one cache per process', async () => {
    const redis = fakeRedis();
    const makeClient = vi.fn(() => redis.client);
    const a = stockCacheFromEnv({ REDIS_URL: 'redis://localhost:6379/3' }, makeClient, {
      warn: vi.fn(),
    });
    const b = stockCacheFromEnv({ REDIS_URL: 'redis://localhost:6379/3' }, makeClient, {
      warn: vi.fn(),
    });
    expect(a).toBe(b);
    expect(makeClient).toHaveBeenCalledTimes(1);
    await a.set('k', 'v', 1000);
    expect(redis.store.get(`${STOCK_CACHE_KEY_PREFIX}k`)).toBe('v');
  });

  it('uses the in-process cache without REDIS_URL (no Redis client is created)', async () => {
    const makeClient = vi.fn(() => fakeRedis().client);
    const cache = stockCacheFromEnv({}, makeClient, { warn: vi.fn() });
    await cache.set('k', 'v', 1000);
    await expect(cache.get('k')).resolves.toBe('v');
    expect(makeClient).not.toHaveBeenCalled();
  });
});
