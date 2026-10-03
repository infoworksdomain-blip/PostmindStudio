import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  bumpLibraryVersionOnce,
  createLibraryCache,
  createUncachedLibraryCache,
  decodeVector,
  encodeVector,
  LIBRARY_CACHE_TTL_SEC,
  LIBRARY_VERSION_KEY,
  libraryCacheEnabled,
  libraryCacheKey,
  normaliseQuery,
  QUERY_EMBEDDING_TTL_SEC,
  queryEmbeddingKey,
  stableStringify,
  type LibraryCacheClient,
} from './cache';

// BACKLOG 20.15 — the shared library read-through cache: hit, miss, version bump, Redis failure
// fallback, the query-embedding cache and the one-off bump used by the seed.

const silent = pino({ level: 'silent' });

/** In-memory stand-in for the three Redis commands (TTL recorded, not enforced). */
function memoryClient() {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  const client: LibraryCacheClient & { disconnect(): void } = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode: 'EX', seconds: number) => {
      store.set(key, value);
      ttl.set(key, seconds);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    disconnect: vi.fn(),
  };
  return { client, store, ttl };
}

function downClient(): LibraryCacheClient {
  const fail = () => Promise.reject(new Error('ECONNREFUSED'));
  return { get: fail, set: fail, incr: fail };
}

const counter = () => ({ inc: vi.fn() });

describe('library cache keys', () => {
  it('stableStringify sorts keys and drops undefined, so equal queries share a key', () => {
    expect(stableStringify({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe(
      '{"a":[2,{"c":"x"}],"b":1}',
    );
    expect(libraryCacheKey('3', 'list', { a: 1, b: 2 })).toBe(
      libraryCacheKey('3', 'list', { b: 2, a: 1, c: undefined }),
    );
  });

  it('embeds the version and the cache name in every key', () => {
    const key = libraryCacheKey('7', 'detail', { id: 'x' });
    expect(key).toMatch(/^studio:library:v7:detail:[0-9a-f]{64}$/);
    expect(libraryCacheKey('8', 'detail', { id: 'x' })).not.toBe(key);
  });

  it('normalises queries (case, spacing, NFKC) and keys embeddings by model too', () => {
    expect(normaliseQuery('  Sourdough   BREAD ')).toBe('sourdough bread');
    expect(normaliseQuery('ﬁsh')).toBe('fish');
    expect(queryEmbeddingKey('m1', 'bread')).not.toBe(queryEmbeddingKey('m2', 'bread'));
    expect(queryEmbeddingKey('m1', 'bread')).toMatch(/^studio:library:qemb:[0-9a-f]{64}$/);
  });

  it('round-trips vectors as float32 base64', () => {
    const vector = [0.5, -0.25, 1, 0];
    const encoded = encodeVector(vector);
    expect(decodeVector(encoded)).toEqual(vector);
    expect(Buffer.from(encoded, 'base64').byteLength).toBe(16);
  });
});

describe('createLibraryCache.read', () => {
  it('misses once, stores with the TTL, then serves the hit without loading', async () => {
    const { client, ttl } = memoryClient();
    const metrics = counter();
    const cache = createLibraryCache({ client, logger: silent, counter: metrics });
    const load = vi.fn(async () => ({ id: 'a', at: new Date('2026-10-01T00:00:00Z') }));

    const first = await cache.read('detail', { id: 'a' }, LIBRARY_CACHE_TTL_SEC, load);
    const second = await cache.read('detail', { id: 'a' }, LIBRARY_CACHE_TTL_SEC, load);

    expect(load).toHaveBeenCalledTimes(1);
    // Same JSON shape on miss and hit (Dates become ISO strings in both).
    expect(first).toEqual({ id: 'a', at: '2026-10-01T00:00:00.000Z' });
    expect(second).toEqual(first);
    expect([...ttl.values()]).toEqual([LIBRARY_CACHE_TTL_SEC]);
    expect(metrics.inc).toHaveBeenCalledWith({ cache: 'detail', result: 'miss' });
    expect(metrics.inc).toHaveBeenCalledWith({ cache: 'detail', result: 'hit' });
  });

  it('a version bump makes the next read load fresh data (no key scanning)', async () => {
    const { client, store } = memoryClient();
    const cache = createLibraryCache({ client, logger: silent, counter: counter() });
    let title = 'old';
    const load = vi.fn(async () => ({ title }));

    expect(await cache.read('list', { page: 1 }, 60, load)).toEqual({ title: 'old' });
    title = 'new';
    expect(await cache.read('list', { page: 1 }, 60, load)).toEqual({ title: 'old' });
    await cache.bump('admin-edit');
    expect(store.get(LIBRARY_VERSION_KEY)).toBe('1');
    expect(await cache.read('list', { page: 1 }, 60, load)).toEqual({ title: 'new' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('falls back to the loader and warns (throttled) while Redis is down', async () => {
    const warn = vi.fn();
    const metrics = counter();
    let t = 0;
    const cache = createLibraryCache({
      client: downClient(),
      logger: { ...silent, warn } as unknown as typeof silent,
      now: () => t,
      counter: metrics,
    });
    const load = vi.fn(async () => ({ ok: true }));
    expect(await cache.read('categories', {}, 60, load)).toEqual({ ok: true });
    expect(await cache.read('categories', {}, 60, load)).toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    t = 61_000;
    await cache.read('categories', {}, 60, load);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(metrics.inc).toHaveBeenCalledWith({ cache: 'categories', result: 'error' });
  });

  it('still answers when only the write fails, and treats bad JSON as a miss', async () => {
    const { client, store } = memoryClient();
    client.set = vi.fn(async () => {
      throw new Error('READONLY');
    });
    const cache = createLibraryCache({ client, logger: silent, counter: counter() });
    expect(await cache.read('blueprint', { id: 'b' }, 60, async () => ({ n: 1 }))).toEqual({
      n: 1,
    });
    store.set(libraryCacheKey('0', 'blueprint', { id: 'c' }), '{not json');
    expect(await cache.read('blueprint', { id: 'c' }, 60, async () => ({ n: 2 }))).toEqual({
      n: 2,
    });
  });

  it('never caches a loader error', async () => {
    const { client, store } = memoryClient();
    const cache = createLibraryCache({ client, logger: silent, counter: counter() });
    await expect(
      cache.read('detail', { id: 'gone' }, 60, async () => {
        throw new Error('not found');
      }),
    ).rejects.toThrow('not found');
    expect(store.size).toBe(0);
  });

  it('a failed bump is logged, never thrown', async () => {
    const warn = vi.fn();
    const cache = createLibraryCache({
      client: downClient(),
      logger: { ...silent, warn } as unknown as typeof silent,
      counter: counter(),
    });
    await expect(cache.bump('retire')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'retire' }),
      expect.stringContaining('version bump failed'),
    );
  });
});

describe('createLibraryCache.embedding', () => {
  it('calls the provider once per (model, normalised query) and stores for 30 days', async () => {
    const { client, ttl } = memoryClient();
    const cache = createLibraryCache({ client, logger: silent, counter: counter() });
    const load = vi.fn(async () => ({ vector: [0.25, 0.5], cacheable: true }));

    expect(await cache.embedding('m', 'Sourdough bread', load)).toEqual([0.25, 0.5]);
    expect(await cache.embedding('m', '  sourdough   BREAD', load)).toEqual([0.25, 0.5]);
    expect(load).toHaveBeenCalledTimes(1);
    expect([...ttl.values()]).toEqual([QUERY_EMBEDDING_TTL_SEC]);
    await cache.embedding('other-model', 'sourdough bread', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not store vectors the loader marks not cacheable', async () => {
    const { client, store } = memoryClient();
    const cache = createLibraryCache({ client, logger: silent, counter: counter() });
    await cache.embedding('m', 'q', async () => ({ vector: [1], cacheable: false }));
    expect(store.size).toBe(0);
  });

  it('falls back to the provider while Redis is down', async () => {
    const cache = createLibraryCache({ client: downClient(), logger: silent, counter: counter() });
    const load = vi.fn(async () => ({ vector: [1, 2], cacheable: true }));
    expect(await cache.embedding('m', 'q', load)).toEqual([1, 2]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('createUncachedLibraryCache', () => {
  it('always loads, with the same JSON shape as the cache', async () => {
    const cache = createUncachedLibraryCache();
    const load = vi.fn(async () => ({ at: new Date(0), n: BigInt(5) }));
    expect(await cache.read('list', {}, 60, load)).toEqual({
      at: '1970-01-01T00:00:00.000Z',
      n: '5',
    });
    await cache.read('list', {}, 60, load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(cache.bump('x')).resolves.toBeUndefined();
    expect(await cache.embedding('m', 'q', async () => ({ vector: [3], cacheable: true }))).toEqual(
      [3],
    );
  });
});

describe('libraryCacheEnabled / bumpLibraryVersionOnce', () => {
  it('is on with REDIS_URL unless STUDIO_LIBRARY_CACHE=off', () => {
    expect(libraryCacheEnabled({ REDIS_URL: 'redis://r:6379/3' })).toBe(true);
    expect(libraryCacheEnabled({})).toBe(false);
    expect(
      libraryCacheEnabled({ REDIS_URL: 'redis://r:6379/3', STUDIO_LIBRARY_CACHE: 'OFF' }),
    ).toBe(false);
  });

  it('bumps once and disconnects; skips without Redis', async () => {
    const { client, store } = memoryClient();
    expect(
      await bumpLibraryVersionOnce('taxonomy-seed', {
        env: { REDIS_URL: 'redis://r:6379/3' },
        connect: () => client,
        logger: silent,
      }),
    ).toBe(true);
    expect(store.get(LIBRARY_VERSION_KEY)).toBe('1');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    const connect = vi.fn(() => client);
    expect(
      await bumpLibraryVersionOnce('taxonomy-seed', { env: {}, connect, logger: silent }),
    ).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});
