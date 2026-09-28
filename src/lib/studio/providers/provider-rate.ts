import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { ConfigurationError } from '../../errors';

// 15.C3 — per-organisation, per-provider rate coordination (spec 11.4: "If the counter is at
// capacity, jobs delay via BullMQ's delay() rather than fail"). Sliding-window counters in
// Redis (Studio DB 3), one per provider (platform-wide: the provider's own account limit) and
// one per (organisation, provider) (fair share: one organisation cannot use the whole limit).
//
// Keys:  studio:prate:<provider>          ZSET  call timestamps inside the provider window
//        studio:prate:<provider>:<org>    ZSET  call timestamps inside the organisation window
// Limits: STUDIO_PROVIDER_RATE_<ID>="<max>/<windowSec>[,org=<max>/<windowSec>]", where <ID> is
// the provider id upper-cased with non-alphanumerics as "_" (e.g. STUDIO_PROVIDER_RATE_PEXELS_VIDEO
// ="200/3600,org=50/3600"). A provider without the variable is not limited.
//
// Fail-open: if Redis errors, the call is allowed and a warning is logged at most once a minute.
// A limiter outage must not stop generation; the provider's own 429s still retry with backoff.

export const RATE_KEY_PREFIX = 'studio:prate:';
const WARN_INTERVAL_MS = 60_000;

export interface RateWindow {
  max: number;
  windowMs: number;
}

export interface ProviderRateLimit {
  provider?: RateWindow;
  organisation?: RateWindow;
}

export type RateSlot = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface ProviderRateLimiter {
  /** Take one call slot, or say how long until one frees. */
  acquire(input: { providerId: string; organisationId: string }): Promise<RateSlot>;
}

export function rateEnvName(providerId: string): string {
  return `STUDIO_PROVIDER_RATE_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function parseWindow(raw: string, name: string): RateWindow {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  const max = Number(match?.[1]);
  const sec = Number(match?.[2]);
  if (!match || !Number.isInteger(max) || max < 1 || !Number.isInteger(sec) || sec < 1) {
    throw new ConfigurationError(
      `${name} must look like "<max>/<windowSec>[,org=<max>/<windowSec>]"`,
    );
  }
  return { max, windowMs: sec * 1000 };
}

/** Parse one STUDIO_PROVIDER_RATE_<ID> value. */
export function parseRateLimit(raw: string, name = 'STUDIO_PROVIDER_RATE_*'): ProviderRateLimit {
  const limit: ProviderRateLimit = {};
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (part.toLowerCase().startsWith('org='))
      limit.organisation = parseWindow(part.slice(4), name);
    else limit.provider = parseWindow(part, name);
  }
  if (!limit.provider && !limit.organisation) {
    throw new ConfigurationError(`${name} is empty`);
  }
  return limit;
}

/** Limits for every provider configured through STUDIO_PROVIDER_RATE_<ID>. */
export function rateLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): (providerId: string) => ProviderRateLimit | undefined {
  return (providerId) => {
    const name = rateEnvName(providerId);
    const raw = env[name]?.trim();
    return raw ? parseRateLimit(raw, name) : undefined;
  };
}

// KEYS: provider zset, organisation zset. ARGV: now, member, provider max, provider window ms,
// organisation max, organisation window ms (max 0 = no limit at that level).
// Returns 0 when a slot was taken, otherwise the milliseconds until the fuller window frees one.
export const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local function wait(key, max, window)
  if max <= 0 then return 0 end
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  if redis.call('ZCARD', key) < max then return 0 end
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return math.max(1, tonumber(oldest[2]) + window - now)
end
local pmax, pwin = tonumber(ARGV[3]), tonumber(ARGV[4])
local omax, owin = tonumber(ARGV[5]), tonumber(ARGV[6])
local delay = math.max(wait(KEYS[1], pmax, pwin), wait(KEYS[2], omax, owin))
if delay > 0 then return delay end
if pmax > 0 then
  redis.call('ZADD', KEYS[1], now, ARGV[2])
  redis.call('PEXPIRE', KEYS[1], pwin)
end
if omax > 0 then
  redis.call('ZADD', KEYS[2], now, ARGV[2])
  redis.call('PEXPIRE', KEYS[2], owin)
end
return 0`;

export interface RateRedisClient {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export function createRedisProviderRateLimiter(deps: {
  client: RateRedisClient;
  limits: (providerId: string) => ProviderRateLimit | undefined;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
}): ProviderRateLimiter {
  const now = deps.now ?? Date.now;
  let lastWarnAt = -Infinity;
  return {
    async acquire({ providerId, organisationId }) {
      const limit = deps.limits(providerId);
      if (!limit) return { allowed: true };
      const t = now();
      try {
        const delay = Number(
          await deps.client.eval(
            ACQUIRE_SCRIPT,
            2,
            `${RATE_KEY_PREFIX}${providerId}`,
            `${RATE_KEY_PREFIX}${providerId}:${organisationId}`,
            String(t),
            `${t}:${randomUUID()}`,
            String(limit.provider?.max ?? 0),
            String(limit.provider?.windowMs ?? 0),
            String(limit.organisation?.max ?? 0),
            String(limit.organisation?.windowMs ?? 0),
          ),
        );
        return delay > 0 ? { allowed: false, retryAfterMs: delay } : { allowed: true };
      } catch (err) {
        if (t - lastWarnAt >= WARN_INTERVAL_MS) {
          lastWarnAt = t;
          deps.logger.warn({ err, providerId }, 'provider rate limiter unavailable; allowing');
        }
        return { allowed: true };
      }
    },
  };
}

/** In-process limiter with the same algorithm (tests, and single-process tools). */
export function createMemoryProviderRateLimiter(
  limits: (providerId: string) => ProviderRateLimit | undefined,
  now: () => number = Date.now,
): ProviderRateLimiter {
  const windows = new Map<string, number[]>();
  const waitFor = (key: string, window: RateWindow | undefined, t: number): number => {
    if (!window) return 0;
    const kept = (windows.get(key) ?? []).filter((at) => at > t - window.windowMs);
    windows.set(key, kept);
    if (kept.length < window.max) return 0;
    return Math.max(1, (kept[0] ?? t) + window.windowMs - t);
  };
  return {
    async acquire({ providerId, organisationId }) {
      const limit = limits(providerId);
      if (!limit) return { allowed: true };
      const t = now();
      const providerKey = providerId;
      const orgKey = `${providerId}:${organisationId}`;
      const delay = Math.max(
        waitFor(providerKey, limit.provider, t),
        waitFor(orgKey, limit.organisation, t),
      );
      if (delay > 0) return { allowed: false, retryAfterMs: delay };
      if (limit.provider) windows.set(providerKey, [...(windows.get(providerKey) ?? []), t]);
      if (limit.organisation) windows.set(orgKey, [...(windows.get(orgKey) ?? []), t]);
      return { allowed: true };
    },
  };
}

/**
 * The production limiter: Redis-backed when REDIS_URL is set and at least one
 * STUDIO_PROVIDER_RATE_<ID> is configured; otherwise undefined (no Studio-side limits).
 */
export function providerRateLimiterFromEnv(
  env: Record<string, string | undefined>,
  makeClient: () => RateRedisClient,
  logger: Pick<Logger, 'warn'>,
): ProviderRateLimiter | undefined {
  const configured = Object.keys(env).some(
    (k) => k.startsWith('STUDIO_PROVIDER_RATE_') && env[k]?.trim(),
  );
  if (!configured || !env.REDIS_URL?.trim()) return undefined;
  return createRedisProviderRateLimiter({
    client: makeClient(),
    limits: rateLimitsFromEnv(env),
    logger,
  });
}
