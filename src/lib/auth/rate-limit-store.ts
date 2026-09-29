import type { Redis } from 'ioredis';

// Phase 18 §5.2 — storage for Better Auth's rate limiter and Studio's per-email limits, on the
// existing Valkey. Better Auth 1.7.6 takes `rateLimit.customStorage.consume(key, rule)`, which
// must check and increment atomically (https://www.better-auth.com/docs/concepts/rate-limit,
// "Custom Storage", read 2026-09-29). A fixed window per key: INCR, and PEXPIRE on the first hit,
// in one Lua script.

export interface RateRule {
  /** Seconds. */
  window: number;
  max: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Seconds until the window resets; null when allowed. */
  retryAfter: number | null;
}

export interface AuthRateLimitStore {
  consume(key: string, rule: RateRule): Promise<ConsumeResult>;
}

const KEY_PREFIX = 'studio:auth-rl:';

const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

export function createRedisAuthRateLimitStore(
  redis: Pick<Redis, 'eval'>,
  options: { onError?: (err: unknown) => void } = {},
): AuthRateLimitStore {
  return {
    async consume(key, rule) {
      try {
        const [count, ttlMs] = (await redis.eval(
          CONSUME_SCRIPT,
          1,
          `${KEY_PREFIX}${key}`,
          String(rule.window * 1000),
        )) as [number, number];
        if (count <= rule.max) return { allowed: true, retryAfter: null };
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttlMs / 1000)) };
      } catch (err) {
        // Valkey down: fail open (like the Studio API limiter) rather than lock everyone out;
        // argon2 slots and 2FA lockout still bound abuse.
        options.onError?.(err);
        return { allowed: true, retryAfter: null };
      }
    },
  };
}

/** Tests and single-process development: the same fixed window in memory. */
export function createMemoryAuthRateLimitStore(now: () => number = Date.now): AuthRateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(key, rule) {
      const t = now();
      const current = windows.get(key);
      const entry =
        current && current.resetAt > t ? current : { count: 0, resetAt: t + rule.window * 1000 };
      entry.count += 1;
      windows.set(key, entry);
      if (entry.count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
    },
  };
}
