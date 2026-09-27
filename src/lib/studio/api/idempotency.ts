import { createHash } from 'node:crypto';
import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

// Idempotency-Key support for mutating endpoints (spec 8.1, Engagement 14.1).
//
// Reserve-then-execute: the key is claimed atomically (SET NX) BEFORE the handler runs, so two
// concurrent requests with the same key can never both execute. The reservation stores a hash
// of the request body; reusing a key with a different body is rejected. On success the final
// response replaces the reservation for 24h; on failure the reservation is released so the
// client can retry.

export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;
/** A reservation outlives any sane request; if a server dies mid-request it frees itself. */
export const RESERVATION_TTL_SEC = 5 * 60;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyEntry =
  | { state: 'processing'; bodyHash: string }
  | { state: 'complete'; bodyHash: string; response: StoredResponse };

export type ReserveResult = { reserved: true } | { reserved: false; existing: IdempotencyEntry };

export interface IdempotencyStore {
  reserve(key: string, bodyHash: string): Promise<ReserveResult>;
  complete(key: string, bodyHash: string, response: StoredResponse): Promise<void>;
  release(key: string): Promise<void>;
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function hashBody(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
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
  const entries = new Map<string, { entry: IdempotencyEntry; expiresAt: number }>();
  const live = (key: string) => {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) return hit.entry;
    entries.delete(key);
    return undefined;
  };
  return {
    async reserve(key, bodyHash) {
      const existing = live(key);
      if (existing) return { reserved: false, existing };
      entries.set(key, {
        entry: { state: 'processing', bodyHash },
        expiresAt: now() + RESERVATION_TTL_SEC * 1000,
      });
      return { reserved: true };
    },
    async complete(key, bodyHash, response) {
      entries.set(key, {
        entry: { state: 'complete', bodyHash, response },
        expiresAt: now() + IDEMPOTENCY_TTL_SEC * 1000,
      });
    },
    async release(key) {
      entries.delete(key);
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
    async reserve(key, bodyHash) {
      const placeholder: IdempotencyEntry = { state: 'processing', bodyHash };
      const ok = await redis.set(key, JSON.stringify(placeholder), 'EX', RESERVATION_TTL_SEC, 'NX');
      if (ok === 'OK') return { reserved: true };
      const raw = await redis.get(key);
      // Expired between SET and GET: treat as a fresh reservation attempt by the caller.
      if (!raw) return this.reserve(key, bodyHash);
      return { reserved: false, existing: JSON.parse(raw) as IdempotencyEntry };
    },
    async complete(key, bodyHash, response) {
      const entry: IdempotencyEntry = { state: 'complete', bodyHash, response };
      await redis.set(key, JSON.stringify(entry), 'EX', IDEMPOTENCY_TTL_SEC);
    },
    async release(key) {
      await redis.del(key);
    },
  };
}
