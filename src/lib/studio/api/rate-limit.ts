import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { ConfigurationError, RateLimitError } from '../../errors';

// Request rate limiting for /api/studio (Phase 4 review list → Phase 12 hardening). Fixed
// one-minute windows in Redis, applied after authentication so limits are per user and per
// organisation (the tenant is known). Unauthenticated floods are the load balancer / WAF's job.
//
//   per user, reads (GET/HEAD)       STUDIO_RATE_LIMIT_READS_PER_MIN   default 600
//   per user, writes (POST/PATCH/…)  STUDIO_RATE_LIMIT_WRITES_PER_MIN  default 120
//   per organisation, all requests   STUDIO_RATE_LIMIT_ORG_PER_MIN     default 3000
//
// Expensive operations keep their own business quotas (scans, image generation, previews).

export const WINDOW_SEC = 60;

export interface RateLimits {
  readsPerMin: number;
  writesPerMin: number;
  orgPerMin: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  readsPerMin: 600,
  writesPerMin: 120,
  orgPerMin: 3_000,
};

export interface WindowCount {
  count: number;
  /** Seconds until the window resets. */
  resetSec: number;
}

export interface RateLimitStore {
  /** Increment the counter for `key` in the current window and return it. */
  hit(key: string, windowSec: number): Promise<WindowCount>;
}

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return n;
}

export function rateLimitsFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    readsPerMin: positiveInt(
      env,
      'STUDIO_RATE_LIMIT_READS_PER_MIN',
      DEFAULT_RATE_LIMITS.readsPerMin,
    ),
    writesPerMin: positiveInt(
      env,
      'STUDIO_RATE_LIMIT_WRITES_PER_MIN',
      DEFAULT_RATE_LIMITS.writesPerMin,
    ),
    orgPerMin: positiveInt(env, 'STUDIO_RATE_LIMIT_ORG_PER_MIN', DEFAULT_RATE_LIMITS.orgPerMin),
  } satisfies RateLimits;
}

export interface RateLimiter {
  /** Throws RateLimitError (429 + Retry-After) when a limit is exceeded. */
  check(input: { organisationId: string; userId: string; method: string }): Promise<void>;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createRateLimiter(
  store: RateLimitStore,
  limits: RateLimits = DEFAULT_RATE_LIMITS,
  options: { onStoreError?: (err: unknown) => void } = {},
): RateLimiter {
  return {
    async check({ organisationId, userId, method }) {
      const isRead = READ_METHODS.has(method.toUpperCase());
      const userLimit = isRead ? limits.readsPerMin : limits.writesPerMin;
      const kind = isRead ? 'r' : 'w';
      let user: WindowCount;
      let org: WindowCount;
      try {
        [user, org] = await Promise.all([
          store.hit(`studio:rl:u:${organisationId}:${userId}:${kind}`, WINDOW_SEC),
          store.hit(`studio:rl:o:${organisationId}`, WINDOW_SEC),
        ]);
      } catch (err) {
        // Fail open: a Redis outage must not take the API down with it (readiness reports
        // Redis separately, and business quotas still apply).
        options.onStoreError?.(err);
        return;
      }
      if (user.count > userLimit) {
        throw new RateLimitError('Too many requests — slow down', Math.max(1, user.resetSec), {
          limit: userLimit,
          scope: 'user',
        });
      }
      if (org.count > limits.orgPerMin) {
        throw new RateLimitError(
          'Too many requests from your organisation — slow down',
          Math.max(1, org.resetSec),
          { limit: limits.orgPerMin, scope: 'organisation' },
        );
      }
    },
  };
}

export function createMemoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return {
    async hit(key, windowSec) {
      const t = now();
      const current = windows.get(key);
      const entry =
        current && current.expiresAt > t
          ? { ...current, count: current.count + 1 }
          : { count: 1, expiresAt: t + windowSec * 1000 };
      windows.set(key, entry);
      return { count: entry.count, resetSec: Math.ceil((entry.expiresAt - t) / 1000) };
    },
  };
}

// INCR + set expiry on the first hit, atomically (works on every Redis version).
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

export function createRedisRateLimitStore(connection: ConnectionOptions): RateLimitStore {
  const redis = new Redis({
    ...(connection as object),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  // Errors surface to the limiter (fail open); don't let ioredis report them as unhandled.
  redis.on('error', () => undefined);
  return {
    async hit(key, windowSec) {
      const [count, ttl] = (await redis.eval(HIT_SCRIPT, 1, key, String(windowSec))) as [
        number,
        number,
      ];
      return { count, resetSec: ttl };
    },
  };
}
