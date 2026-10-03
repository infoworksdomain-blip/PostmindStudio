import type { Logger } from 'pino';

// BACKLOG 20.16 — cache for stock search responses. Pixabay's API terms
// (https://pixabay.com/api/docs/, read 2026-10-01): "Requests must be cached for 24 hours."
// Shared through Redis (Studio DB 3) so the web and worker processes reuse one answer; when Redis
// is not configured, or a command fails, an in-process LRU is used instead (fail-open: a cache
// outage never blocks a search, it only costs an extra API call). Keys never contain API keys.

export const STOCK_CACHE_KEY_PREFIX = 'studio:stockcache:';
/** 24 hours (Pixabay's minimum caching period). */
export const STOCK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** In-process LRU bound: responses are small JSON, a few KB each. */
export const STOCK_CACHE_MAX_ENTRIES = 500;
const WARN_INTERVAL_MS = 60_000;

export interface StockSearchCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/** In-process LRU with a per-entry expiry (Map keeps insertion order; re-insert on read). */
export function createMemoryStockCache(
  options: { maxEntries?: number; now?: () => number } = {},
): StockSearchCache {
  const maxEntries = options.maxEntries ?? STOCK_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt <= now()) return null;
      entries.set(key, entry);
      return entry.value;
    },
    async set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

/** The subset of ioredis the cache uses (SET key value PX ttl). */
export interface StockCacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
}

/** Redis-backed cache; any Redis error falls back to `fallback` (warned at most once a minute). */
export function createRedisStockCache(deps: {
  client: StockCacheRedisClient;
  fallback: StockSearchCache;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
}): StockSearchCache {
  const now = deps.now ?? Date.now;
  let lastWarnAt = -Infinity;
  const warn = (err: unknown) => {
    const t = now();
    if (t - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = t;
    deps.logger.warn({ err }, 'stock search cache unavailable; using the in-process cache');
  };
  return {
    async get(key) {
      try {
        return await deps.client.get(`${STOCK_CACHE_KEY_PREFIX}${key}`);
      } catch (err) {
        warn(err);
        return deps.fallback.get(key);
      }
    },
    async set(key, value, ttlMs) {
      try {
        await deps.client.set(`${STOCK_CACHE_KEY_PREFIX}${key}`, value, 'PX', ttlMs);
      } catch (err) {
        warn(err);
        await deps.fallback.set(key, value, ttlMs);
      }
    },
  };
}

/**
 * The production cache: Redis when REDIS_URL is set, else in-process. One per process, so the
 * in-process LRU survives across the per-job `stockSourcesFromEnv()` calls.
 */
let processCache: StockSearchCache | undefined;

export function stockCacheFromEnv(
  env: Record<string, string | undefined>,
  makeClient: () => StockCacheRedisClient,
  logger: Pick<Logger, 'warn'>,
): StockSearchCache {
  if (processCache) return processCache;
  const memory = createMemoryStockCache();
  processCache = env.REDIS_URL?.trim()
    ? createRedisStockCache({ client: makeClient(), fallback: memory, logger })
    : memory;
  return processCache;
}

/** Tests only: forget the process cache. */
export function resetStockCacheForTests(): void {
  processCache = undefined;
}
