import { createHash } from 'node:crypto';
import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { Counter } from 'prom-client';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../../logger';
import { getMetrics } from '../observability/metrics';

// BACKLOG 20.15 — shared read-through cache for the reference video library.
//
// The library is platform-wide (organisation 'postmind-platform'): every customer sees the same
// catalogue, so one cached copy in Studio's Redis (DB 3) serves everyone. Keys:
//
//   studio:library:version                          STRING  catalogue version (INCR on change)
//   studio:library:v<version>:<name>:<sha256>       STRING  JSON of one read, TTL 15 min / 1 h
//   studio:library:qemb:<sha256(model, query)>      STRING  base64 float32 query embedding, 30 days
//
// Every catalogue write (ingest, admin edit, licence change, retire, bulk review, re-analysis,
// taxonomy seed) INCRs the version. Readers embed the version in every key, so a change is
// visible on the next request with no key scanning or deletes; old-version keys simply expire.
//
// Cached values never contain signed URLs: they are signed per response (library.ts), with a
// stable signing window for thumbnails.
//
// Fail-safe: any Redis error (down, timeout, bad JSON) falls back to the loader (the database)
// and logs a warning at most once a minute. A cache problem never fails a request.

/** Browse, detail, similar, blueprint, categories and search pages. */
export const LIBRARY_CACHE_TTL_SEC = 15 * 60;
/** Per-business recommendations (their input, the business profile, changes rarely). */
export const LIBRARY_RECOMMENDED_TTL_SEC = 60 * 60;
/** Query embeddings depend only on the text and the model, never on the catalogue. */
export const QUERY_EMBEDDING_TTL_SEC = 30 * 24 * 60 * 60;

export const LIBRARY_CACHE_PREFIX = 'studio:library:';
export const LIBRARY_VERSION_KEY = `${LIBRARY_CACHE_PREFIX}version`;
const EMBEDDING_PREFIX = `${LIBRARY_CACHE_PREFIX}qemb:`;
const WARN_INTERVAL_MS = 60_000;

/** Bounded metric label values (studio_library_cache_total{cache}). */
export const LIBRARY_CACHE_NAMES = [
  'categories',
  'list',
  'detail',
  'similar',
  'blueprint',
  'recommended',
  'search',
  'embedding',
] as const;
export type LibraryCacheName = (typeof LIBRARY_CACHE_NAMES)[number];
export type LibraryCacheResult = 'hit' | 'miss' | 'error';

/** The JSON round trip of T: what a cached (or freshly loaded) value looks like to callers. */
export type Jsonified<T> = T extends Date
  ? string
  : T extends bigint
    ? string
    : T extends ReadonlyArray<infer U>
      ? Jsonified<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonified<T[K]> }
        : T;

/** The Redis commands the cache uses (ioredis satisfies it; tests pass an in-memory double). */
export interface LibraryCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  incr(key: string): Promise<number>;
}

export interface LibraryCache {
  /**
   * Read-through: the cached value for (name, parts) at the current catalogue version, else
   * load() stored for ttlSec. Hit and miss return the same JSON shape.
   */
  read<T>(
    name: LibraryCacheName,
    parts: unknown,
    ttlSec: number,
    load: () => Promise<T>,
  ): Promise<Jsonified<T>>;
  /** Mark the catalogue changed. Never throws (a failed bump is logged; TTL bounds staleness). */
  bump(reason: string): Promise<void>;
  /**
   * A query embedding for (model, query): from the cache, else load(). Only vectors load()
   * marks cacheable are stored (an unexpected provider's vectors are not shared).
   */
  embedding(
    model: string,
    query: string,
    load: () => Promise<{ vector: number[]; cacheable: boolean }>,
  ): Promise<number[]>;
}

export interface LibraryCacheDeps {
  client: LibraryCacheClient;
  logger?: Logger;
  now?: () => number;
  counter?: Pick<Counter<'cache' | 'result'>, 'inc'>;
}

/** JSON with sorted object keys and undefined dropped: equal inputs give equal key hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function libraryCacheKey(version: string, name: LibraryCacheName, parts: unknown): string {
  return `${LIBRARY_CACHE_PREFIX}v${version}:${name}:${sha256(stableStringify(parts))}`;
}

/** Lower-case, NFKC, single spaces: "  Sourdough   BREAD " and "sourdough bread" share a key. */
export function normaliseQuery(q: string): string {
  return q.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function queryEmbeddingKey(model: string, normalisedQuery: string): string {
  return `${EMBEDDING_PREFIX}${sha256(`${model}\n${normalisedQuery}`)}`;
}

function toJson<T>(value: T): Jsonified<T> {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Jsonified<T>;
}

/** float32 little-endian, base64: 1536 dims = 8 KB instead of ~30 KB of JSON. */
export function encodeVector(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Array.from(new Float32Array(copy.buffer));
}

export function createLibraryCache(deps: LibraryCacheDeps): LibraryCache {
  const log = deps.logger ?? rootLogger;
  const now = deps.now ?? Date.now;
  const counter = deps.counter ?? getMetrics().libraryCache;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  const count = (cache: LibraryCacheName, result: LibraryCacheResult) =>
    counter.inc({ cache, result });
  const warn = (err: unknown, op: string) => {
    if (now() - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = now();
    log.warn({ err, op }, 'library cache: Redis unavailable, reading from the database');
  };
  /** Store without blocking the response on failure. */
  const store = async (key: string, value: string, ttlSec: number, op: string) => {
    try {
      await deps.client.set(key, value, 'EX', ttlSec);
    } catch (err) {
      warn(err, op);
    }
  };

  return {
    async read(name, parts, ttlSec, load) {
      let key: string;
      try {
        const version = (await deps.client.get(LIBRARY_VERSION_KEY)) ?? '0';
        key = libraryCacheKey(version, name, parts);
        const cached = await deps.client.get(key);
        if (cached !== null) {
          const parsed = JSON.parse(cached) as Jsonified<Awaited<ReturnType<typeof load>>>;
          count(name, 'hit');
          return parsed;
        }
      } catch (err) {
        count(name, 'error');
        warn(err, `read:${name}`);
        return toJson(await load());
      }
      count(name, 'miss');
      const fresh = toJson(await load());
      await store(key, JSON.stringify(fresh), ttlSec, `write:${name}`);
      return fresh;
    },

    async bump(reason) {
      try {
        const version = await deps.client.incr(LIBRARY_VERSION_KEY);
        log.info({ reason, version }, 'library cache version bumped');
      } catch (err) {
        // Not throttled: a missed bump means readers may see the old catalogue for up to
        // LIBRARY_CACHE_TTL_SEC, which an operator should be able to see in the logs.
        log.warn({ err, reason }, 'library cache: version bump failed; cached reads may be stale');
      }
    },

    async embedding(model, query, load) {
      const key = queryEmbeddingKey(model, normaliseQuery(query));
      try {
        const cached = await deps.client.get(key);
        if (cached !== null) {
          const vector = decodeVector(cached);
          if (vector.length > 0) {
            count('embedding', 'hit');
            return vector;
          }
        }
        count('embedding', 'miss');
      } catch (err) {
        count('embedding', 'error');
        warn(err, 'read:embedding');
        return (await load()).vector;
      }
      const fresh = await load();
      if (fresh.cacheable)
        await store(key, encodeVector(fresh.vector), QUERY_EMBEDDING_TTL_SEC, 'write:embedding');
      return fresh.vector;
    },
  };
}

/** No Redis (tests, scripts without REDIS_URL): always load, same JSON shape as the cache. */
export function createUncachedLibraryCache(): LibraryCache {
  return {
    read: async (_name, _parts, _ttl, load) => toJson(await load()),
    bump: async () => undefined,
    embedding: async (_model, _query, load) => (await load()).vector,
  };
}

/** A dedicated ioredis client that fails fast (never queues commands while Redis is down). */
export function createLibraryCacheRedisClient(connection: ConnectionOptions): Redis {
  const redis = new Redis({
    ...(connection as object),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 500,
  });
  // Failures surface per command (and fall back); keep ioredis from reporting them unhandled.
  redis.on('error', () => undefined);
  return redis;
}

/**
 * STUDIO_LIBRARY_CACHE: "redis" (default when REDIS_URL is set) or "off". Off = every read goes
 * to the database (the pre-20.15 behaviour).
 */
export function libraryCacheEnabled(env: Record<string, string | undefined> = process.env) {
  const raw = env.STUDIO_LIBRARY_CACHE?.trim().toLowerCase() ?? '';
  if (raw === 'off') return false;
  return Boolean(env.REDIS_URL?.trim());
}

/** A client for one-off processes: queues commands until connected, gives up after 5 s. */
export function createOneOffRedisClient(connection: ConnectionOptions): Redis {
  return new Redis({
    ...(connection as object),
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  });
}

/**
 * Bump the version from a one-off process (prisma seed, ops scripts): connect, INCR, quit.
 * Skipped (logged) without REDIS_URL or with the cache off.
 */
export async function bumpLibraryVersionOnce(
  reason: string,
  options: {
    env?: Record<string, string | undefined>;
    connect: () => LibraryCacheClient & { disconnect(): void };
    logger?: Logger;
  },
): Promise<boolean> {
  const log = options.logger ?? rootLogger;
  if (!libraryCacheEnabled(options.env)) {
    log.info({ reason }, 'library cache off (no REDIS_URL): no version bump needed');
    return false;
  }
  const client = options.connect();
  try {
    await createLibraryCache({ client, logger: log }).bump(reason);
    return true;
  } finally {
    client.disconnect();
  }
}
