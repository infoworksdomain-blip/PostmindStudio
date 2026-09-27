import { Redis } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';

// Idempotency-Key support for mutating endpoints (spec 8.1, Engagement 14.1): a repeated request
// with the same key (per organisation, user, method and path) replays the first response for 24h.
// Only successful (2xx) responses are stored, so a failed request can be retried with the key.

export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<StoredResponse | null>;
  set(key: string, response: StoredResponse): Promise<void>;
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function idempotencyScope(input: {
  organisationId: string;
  userId: string;
  method: string;
  path: string;
  key: string;
}): string {
  return `studio:idem:${input.organisationId}:${input.userId}:${input.method}:${input.path}:${input.key}`;
}

export function createMemoryIdempotencyStore(now: () => number = Date.now): IdempotencyStore {
  const entries = new Map<string, { response: StoredResponse; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) return null;
      return entry.response;
    },
    async set(key, response) {
      entries.set(key, { response, expiresAt: now() + IDEMPOTENCY_TTL_SEC * 1000 });
    },
  };
}

export function createRedisIdempotencyStore(connection: ConnectionOptions): IdempotencyStore {
  const redis = new Redis({
    ...(connection as object),
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  return {
    async get(key) {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as StoredResponse) : null;
    },
    async set(key, response) {
      // NX: the first stored response wins if two identical requests race.
      await redis.set(key, JSON.stringify(response), 'EX', IDEMPOTENCY_TTL_SEC, 'NX');
    },
  };
}
