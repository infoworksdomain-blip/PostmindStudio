import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { ConfigurationError } from '../../errors';
import type { RateRedisClient } from './provider-rate';

// 20.29 (load test, operator requests 2026-10-03) — per-provider CONCURRENCY limits with a fair
// share per organisation. 15.C3 limits calls per time window (requests a minute); generation
// providers also cap how many jobs may be IN FLIGHT at once per account, and answer a submit over
// that cap with an error:
//   - BytePlus ModelArk (Seedance): 3 concurrent tasks on an individual account, 10 on enterprise
//     (operator, 2026-10-03; RPM 180 / 600);
//   - Kling: 20 concurrent tasks per account + model + resource pack, error 1303 over it
//     (https://kling.ai/document-api/api/get-started/concurrency-rules, cited in kling.ts).
// Without a Studio-side cap, N videos started together submit N × clips at once: everything over
// the account's cap fails (429 / 1303), five failures open the provider's breaker for 5 minutes
// and the rest of the burst fails over to dearer providers. With the cap, a job that finds the
// provider full is DELAYED (RateDeferredError → worker-host moveToDelayed, no attempt spent) and
// starts when a slot frees: the burst queues instead of failing.
//
// Fairness ("one organisation must not starve the others"): an organisation may hold at most its
// share of a provider's slots on the platform account (default ceil(max / 2): Seedance 2 of 3,
// Kling 10 of 20), so whatever one organisation starts, a slot is always left for the next one.
// Waiting jobs retry with jitter, so freed slots go to whichever organisation asks first.
//
// A Redis semaphore per provider (Studio DB 3), shared by every worker process:
//   studio:pconc:<provider>              ZSET  member = lease id, score = lease expiry (ms)
//   studio:pconc:<provider>:org:<org>    ZSET  the organisation's leases on the platform account
//   studio:pconc:<provider>:byoc:<org>   ZSET  an organisation's OWN keys (P1 BYOC: their account,
//                                              their limit; no share applies)
// A lease is released when the provider job ends (success, failure, timeout); a worker that dies
// mid-job leaks its slot only until the lease expires (the provider timeout + 2 minutes).
//
// Limits: STUDIO_PROVIDER_CONCURRENCY_<ID>="<max>[,org=<share>]" (the provider id upper-cased,
// non-alphanumerics as "_"); 0 or "off" = no Studio-side cap. Defaults below; providers without a
// default are not capped (their 429s still defer the job: queue/rate-deferral.ts).
// 23.2: ElevenLabs (TTS + Music, one pool: CONCURRENCY_POOLS) defaults to the plan's 5, so a burst
// of narration and music queues instead of failing with concurrent_limit_exceeded; any provider
// can be capped the same way with its variable (e.g. STUDIO_PROVIDER_CONCURRENCY_HEYGEN=3).
//
// Fail-open, like 15.C3: if Redis errors the call goes ahead (warned at most once a minute).

export const CONCURRENCY_KEY_PREFIX = 'studio:pconc:';
const CONCURRENCY_ENV_PREFIX = 'STUDIO_PROVIDER_CONCURRENCY_';
const WARN_INTERVAL_MS = 60_000;
/** A lease outlives the longest provider job (providerTimeoutMs) by this much. */
export const LEASE_MARGIN_MS = 2 * 60_000;
/** How long a job waits before asking for a slot again (plus up to the same again, jittered). */
export const SLOT_RETRY_MS = 10_000;

/**
 * Documented defaults (20.29). Only the two providers whose concurrency caps we know: the operator's
 * BytePlus individual-account figure and Kling's published resource-pack figure. Raise Seedance to
 * 10 with STUDIO_PROVIDER_CONCURRENCY_SEEDANCE=10 once the BytePlus account is enterprise.
 */
export const DEFAULT_PROVIDER_CONCURRENCY: Readonly<Record<string, number>> = {
  seedance: 3,
  kling: 20,
  // 23.2: the ElevenLabs plan allows 5 concurrent requests (production 2026-10-06: a TTS call
  // failed with "rate_limited: concurrent_limit_exceeded … maximum of 5 concurrent").
  elevenlabs: 5,
};

/**
 * 23.2: providers that share ONE account's slots: ElevenLabs Music runs on the same key and plan
 * as ElevenLabs TTS (default-registry.ts), so speech and music together hold at most the
 * account's 5. A pooled provider uses its pool's limit, env variable and Redis keys.
 */
export const CONCURRENCY_POOLS: Readonly<Record<string, string>> = {
  'elevenlabs-music': 'elevenlabs',
};

/** The provider id whose slots a provider uses (itself unless pooled). */
export function concurrencyPoolOf(providerId: string): string {
  return CONCURRENCY_POOLS[providerId] ?? providerId;
}

export interface ConcurrencyLimit {
  /** Slots on the account. */
  max: number;
  /** Slots one organisation may hold on the platform account. */
  perOrganisation: number;
}

export type ConcurrencySlot =
  | { acquired: true; release(): Promise<void> }
  | { acquired: false; retryAfterMs: number; reason: 'provider_full' | 'organisation_share' };

export interface ProviderConcurrencyLimiter {
  /**
   * Take one in-flight slot for the provider. `byoc` = the call runs on the organisation's own keys
   * (its own account: its own slots, no share).
   */
  acquire(input: {
    providerId: string;
    organisationId: string;
    byoc?: boolean;
    leaseMs: number;
    /** Who is waiting (e.g. the shot): counted once while refused, to pace the retries. */
    waiterId?: string;
  }): Promise<ConcurrencySlot>;
}

export function concurrencyEnvName(providerId: string): string {
  return `${CONCURRENCY_ENV_PREFIX}${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** The default organisation share: half the slots, rounded up (always at least one). */
export function defaultShare(max: number): number {
  return Math.max(1, Math.ceil(max / 2));
}

/**
 * One STUDIO_PROVIDER_CONCURRENCY_<ID> value: "<max>[,org=<share>]" with max 1–1000 and share
 * 1–max, or 0 / "off" for no cap (undefined).
 */
export function parseConcurrency(raw: string, name: string): ConcurrencyLimit | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === '0') return undefined;
  const match = /^(\d+)\s*(?:,\s*org\s*=\s*(\d+))?$/.exec(value);
  const max = Number(match?.[1]);
  const share = match?.[2] === undefined ? defaultShare(max) : Number(match[2]);
  if (!match || max < 1 || max > 1_000 || share < 1 || share > max) {
    throw new ConfigurationError(
      `${name} must be "<max>[,org=<share>]" (max 1–1000, share 1–max), 0 or "off"`,
    );
  }
  return { max, perOrganisation: share };
}

/** The cap for a provider: env override, else the documented default, else none (undefined). */
export function concurrencyLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): (providerId: string) => ConcurrencyLimit | undefined {
  // Every variable is checked once, up front: a typo fails the worker at start, not mid-job.
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(CONCURRENCY_ENV_PREFIX) && value?.trim()) parseConcurrency(value, name);
  }
  return (providerId) => {
    const name = concurrencyEnvName(providerId);
    const raw = env[name]?.trim();
    if (raw) return parseConcurrency(raw, name);
    const max = DEFAULT_PROVIDER_CONCURRENCY[providerId];
    return max ? { max, perOrganisation: defaultShare(max) } : undefined;
  };
}

/** How long a refused waiter stays counted without asking again. */
export const WAITER_TTL_MS = 5 * 60_000;
/** Slowest polling: SLOT_RETRY_MS × this (plus jitter), with many waiters per slot. */
export const MAX_RETRY_FACTOR = 6;
export const SLOT_RETRY_ENV = 'STUDIO_PROVIDER_SLOT_RETRY_MS';

/**
 * Wait before the next try: `base` (+ up to `base` jitter so delayed jobs do not wake together),
 * stretched with the queue — one step per two waiters per slot, at most MAX_RETRY_FACTOR × — so a
 * long queue polls Redis and the database less often. With many waiters a freed slot is still
 * taken within moments; with few, they ask again every 10–20 s.
 */
export function slotRetryMs(
  random: () => number = Math.random,
  waiters = 0,
  max = 1,
  base: number = SLOT_RETRY_MS,
): number {
  const factor = Math.min(MAX_RETRY_FACTOR, Math.max(1, Math.ceil(waiters / (2 * max))));
  return base * factor + Math.floor(random() * base);
}

/** STUDIO_PROVIDER_SLOT_RETRY_MS (100–600000), else SLOT_RETRY_MS. */
export function slotRetryBaseFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[SLOT_RETRY_ENV]?.trim();
  if (!raw) return SLOT_RETRY_MS;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 100 || n > 600_000) {
    throw new ConfigurationError(`${SLOT_RETRY_ENV} must be a whole number of ms, 100–600000`);
  }
  return n;
}

interface SlotKeys {
  account: string;
  waiting: string;
  /** Absent for BYOC (no share on an organisation's own account). */
  organisation?: string;
  max: number;
  share: number;
}

function slotKeys(
  input: { providerId: string; organisationId: string; byoc?: boolean },
  limit: ConcurrencyLimit,
): SlotKeys {
  const base = `${CONCURRENCY_KEY_PREFIX}${input.providerId}`;
  return input.byoc
    ? {
        account: `${base}:byoc:${input.organisationId}`,
        waiting: `${base}:byoc:${input.organisationId}:waiting`,
        max: limit.max,
        share: limit.max,
      }
    : {
        account: base,
        waiting: `${base}:waiting`,
        organisation: `${base}:org:${input.organisationId}`,
        max: limit.max,
        share: limit.perOrganisation,
      };
}

// KEYS: the account's lease zset, its waiting zset, [the organisation's lease zset]. ARGV: now,
// lease id, max, share, lease expiry, waiter id, waiter expiry. Returns {code, waiters}: code 1 =
// slot taken, 0 = the account is full, -1 = the organisation holds its share; waiters = how many
// are waiting for this account (the caller paces its retry by it).
export const ACQUIRE_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if #KEYS > 2 then redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now) end
local code = 1
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then code = 0
elseif #KEYS > 2 and redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[4]) then code = -1 end
if code ~= 1 then
  redis.call('ZADD', KEYS[2], tonumber(ARGV[7]), ARGV[6])
  redis.call('PEXPIREAT', KEYS[2], tonumber(ARGV[7]))
  return {code, redis.call('ZCARD', KEYS[2])}
end
redis.call('ZREM', KEYS[2], ARGV[6])
redis.call('ZADD', KEYS[1], expiry, ARGV[2])
redis.call('PEXPIREAT', KEYS[1], expiry)
if #KEYS > 2 then
  redis.call('ZADD', KEYS[3], expiry, ARGV[2])
  redis.call('PEXPIREAT', KEYS[3], expiry)
end
return {1, 0}`;

export const RELEASE_SLOT_SCRIPT = `
for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1`;

/** The script's {code, waiters} (a bare number from older doubles = the code, no waiters). */
export function parseAcquireReply(reply: unknown): { code: number; waiters: number } {
  if (Array.isArray(reply)) return { code: Number(reply[0]), waiters: Number(reply[1] ?? 0) || 0 };
  return { code: Number(reply), waiters: 0 };
}

function refused(
  code: number,
  waiters: number,
  max: number,
  base: number,
  random?: () => number,
): ConcurrencySlot {
  return {
    acquired: false,
    retryAfterMs: slotRetryMs(random, waiters, max, base),
    reason: code === -1 ? 'organisation_share' : 'provider_full',
  };
}

export function createRedisProviderConcurrencyLimiter(deps: {
  client: RateRedisClient;
  limits: (providerId: string) => ConcurrencyLimit | undefined;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
  random?: () => number;
  /** SLOT_RETRY_MS unless set (the load-test harness scales it with its time scale). */
  retryBaseMs?: number;
}): ProviderConcurrencyLimiter {
  const now = deps.now ?? Date.now;
  const base = deps.retryBaseMs ?? SLOT_RETRY_MS;
  let lastWarnAt = -Infinity;
  const warn = (err: unknown, providerId: string, what: string) => {
    const t = now();
    if (t - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = t;
    deps.logger.warn({ err, providerId }, `provider concurrency limiter unavailable (${what})`);
  };
  const open: ConcurrencySlot = { acquired: true, release: async () => undefined };
  return {
    async acquire(raw) {
      const input = { ...raw, providerId: concurrencyPoolOf(raw.providerId) };
      const limit = deps.limits(input.providerId);
      if (!limit) return open;
      const keys = slotKeys(input, limit);
      const lease = randomUUID();
      const t = now();
      const leaseKeys = keys.organisation ? [keys.account, keys.organisation] : [keys.account];
      try {
        const { code, waiters } = parseAcquireReply(
          await deps.client.eval(
            ACQUIRE_SLOT_SCRIPT,
            leaseKeys.length + 1,
            keys.account,
            keys.waiting,
            ...(keys.organisation ? [keys.organisation] : []),
            String(t),
            lease,
            String(keys.max),
            String(keys.share),
            String(t + input.leaseMs),
            input.waiterId ?? lease,
            String(t + WAITER_TTL_MS),
          ),
        );
        if (code !== 1) return refused(code, waiters, keys.max, base, deps.random);
      } catch (err) {
        warn(err, input.providerId, 'acquire');
        return open;
      }
      return {
        acquired: true,
        release: async () => {
          try {
            await deps.client.eval(RELEASE_SLOT_SCRIPT, leaseKeys.length, ...leaseKeys, lease);
          } catch (err) {
            // The lease expires on its own; a failed release only delays the next job.
            warn(err, input.providerId, 'release');
          }
        },
      };
    },
  };
}

/** In-process limiter with the same rules (tests, single-process tools). */
export function createMemoryProviderConcurrencyLimiter(
  limits: (providerId: string) => ConcurrencyLimit | undefined,
  now: () => number = Date.now,
  random: () => number = Math.random,
): ProviderConcurrencyLimiter & {
  inFlight(providerId: string, organisationId?: string): number;
} {
  const sets = new Map<string, ReadonlyMap<string, number>>();
  const live = (key: string): ReadonlyMap<string, number> => {
    const t = now();
    const kept = new Map(
      [...(sets.get(key) ?? new Map<string, number>())].filter(([, e]) => e > t),
    );
    sets.set(key, kept);
    return kept;
  };
  const add = (key: string, id: string, expiry: number) =>
    sets.set(key, new Map([...live(key), [id, expiry]]));
  const remove = (key: string, id: string) =>
    sets.set(key, new Map([...(sets.get(key) ?? [])].filter(([k]) => k !== id)));
  return {
    async acquire(raw) {
      const input = { ...raw, providerId: concurrencyPoolOf(raw.providerId) };
      const limit = limits(input.providerId);
      if (!limit) return { acquired: true, release: async () => undefined };
      const keys = slotKeys(input, limit);
      const lease = randomUUID();
      const waiter = input.waiterId ?? lease;
      const full = live(keys.account).size >= keys.max;
      const shareFull = !full && keys.organisation && live(keys.organisation).size >= keys.share;
      if (full || shareFull) {
        add(keys.waiting, waiter, now() + WAITER_TTL_MS);
        return refused(full ? 0 : -1, live(keys.waiting).size, keys.max, SLOT_RETRY_MS, random);
      }
      remove(keys.waiting, waiter);
      const leaseKeys = keys.organisation ? [keys.account, keys.organisation] : [keys.account];
      for (const key of leaseKeys) add(key, lease, now() + input.leaseMs);
      return {
        acquired: true,
        release: async () => {
          for (const key of leaseKeys) remove(key, lease);
        },
      };
    },
    inFlight(providerId, organisationId) {
      const base = `${CONCURRENCY_KEY_PREFIX}${concurrencyPoolOf(providerId)}`;
      return live(organisationId ? `${base}:org:${organisationId}` : base).size;
    },
  };
}

export const OVERFLOW_ENV = 'STUDIO_PROVIDER_OVERFLOW';

/**
 * STUDIO_PROVIDER_OVERFLOW: 'queue' (default: a full provider's work waits for a slot, cheapest)
 * or 'failover' (try the next provider for the capability first; waits only when all are full).
 */
export function providerOverflowFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): 'queue' | 'failover' {
  const raw = env[OVERFLOW_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'queue') return 'queue';
  if (raw === 'failover') return 'failover';
  throw new ConfigurationError(`${OVERFLOW_ENV} must be "queue" or "failover"`);
}

/**
 * The production limiter: Redis-backed whenever REDIS_URL is set (the defaults apply without any
 * STUDIO_PROVIDER_CONCURRENCY_* variable); undefined without Redis (no Studio-side caps).
 */
export function providerConcurrencyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  makeClient: () => RateRedisClient,
  logger: Pick<Logger, 'warn'>,
): ProviderConcurrencyLimiter | undefined {
  if (!env.REDIS_URL?.trim()) return undefined;
  const limits = concurrencyLimitsFromEnv(env);
  const retryBaseMs = slotRetryBaseFromEnv(env);
  return createRedisProviderConcurrencyLimiter({
    client: makeClient(),
    limits,
    logger,
    retryBaseMs,
  });
}
