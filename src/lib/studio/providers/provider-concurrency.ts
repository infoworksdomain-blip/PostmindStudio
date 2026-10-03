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
};

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

/** Jittered wait before the next try, so delayed jobs do not all wake in the same instant. */
export function slotRetryMs(random: () => number = Math.random): number {
  return SLOT_RETRY_MS + Math.floor(random() * SLOT_RETRY_MS);
}

interface SlotKeys {
  account: string;
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
    ? { account: `${base}:byoc:${input.organisationId}`, max: limit.max, share: limit.max }
    : {
        account: base,
        organisation: `${base}:org:${input.organisationId}`,
        max: limit.max,
        share: limit.perOrganisation,
      };
}

// KEYS: the account's lease zset, the organisation's lease zset. ARGV: now, lease id, max, share,
// lease expiry. Returns 1 = slot taken, 0 = the account is full, -1 = the organisation holds its
// share. With one key (BYOC) only the account is checked.
export const ACQUIRE_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[5])
for i = 1, #KEYS do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
if #KEYS > 1 and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -1 end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], expiry, ARGV[2])
  redis.call('PEXPIREAT', KEYS[i], expiry)
end
return 1`;

export const RELEASE_SLOT_SCRIPT = `
for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1`;

function refused(code: number, random?: () => number): ConcurrencySlot {
  return {
    acquired: false,
    retryAfterMs: slotRetryMs(random),
    reason: code === -1 ? 'organisation_share' : 'provider_full',
  };
}

export function createRedisProviderConcurrencyLimiter(deps: {
  client: RateRedisClient;
  limits: (providerId: string) => ConcurrencyLimit | undefined;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
  random?: () => number;
}): ProviderConcurrencyLimiter {
  const now = deps.now ?? Date.now;
  let lastWarnAt = -Infinity;
  const warn = (err: unknown, providerId: string, what: string) => {
    const t = now();
    if (t - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = t;
    deps.logger.warn({ err, providerId }, `provider concurrency limiter unavailable (${what})`);
  };
  const open: ConcurrencySlot = { acquired: true, release: async () => undefined };
  return {
    async acquire(input) {
      const limit = deps.limits(input.providerId);
      if (!limit) return open;
      const keys = slotKeys(input, limit);
      const keyList = keys.organisation ? [keys.account, keys.organisation] : [keys.account];
      const lease = randomUUID();
      const t = now();
      try {
        const code = Number(
          await deps.client.eval(
            ACQUIRE_SLOT_SCRIPT,
            keyList.length,
            ...keyList,
            String(t),
            lease,
            String(keys.max),
            String(keys.share),
            String(t + input.leaseMs),
          ),
        );
        if (code !== 1) return refused(code, deps.random);
      } catch (err) {
        warn(err, input.providerId, 'acquire');
        return open;
      }
      return {
        acquired: true,
        release: async () => {
          try {
            await deps.client.eval(RELEASE_SLOT_SCRIPT, keyList.length, ...keyList, lease);
          } catch (err) {
            // The lease expires on its own; a failed release only delays the next job.
            warn(err, input.providerId, 'release');
          }
        },
      };
    },
  };
}

/** In-process limiter with the same rules (tests, the load-test harness, single-process tools). */
export function createMemoryProviderConcurrencyLimiter(
  limits: (providerId: string) => ConcurrencyLimit | undefined,
  now: () => number = Date.now,
  random: () => number = Math.random,
): ProviderConcurrencyLimiter & {
  inFlight(providerId: string, organisationId?: string): number;
} {
  const leases = new Map<string, ReadonlyMap<string, number>>();
  const live = (key: string): ReadonlyMap<string, number> => {
    const t = now();
    const kept = new Map(
      [...(leases.get(key) ?? new Map<string, number>())].filter(([, e]) => e > t),
    );
    leases.set(key, kept);
    return kept;
  };
  return {
    async acquire(input) {
      const limit = limits(input.providerId);
      if (!limit) return { acquired: true, release: async () => undefined };
      const keys = slotKeys(input, limit);
      if (live(keys.account).size >= keys.max) return refused(0, random);
      if (keys.organisation && live(keys.organisation).size >= keys.share) {
        return refused(-1, random);
      }
      const lease = randomUUID();
      const keyList = keys.organisation ? [keys.account, keys.organisation] : [keys.account];
      for (const key of keyList) {
        leases.set(key, new Map([...live(key), [lease, now() + input.leaseMs]]));
      }
      return {
        acquired: true,
        release: async () => {
          for (const key of keyList) {
            leases.set(key, new Map([...(leases.get(key) ?? [])].filter(([id]) => id !== lease)));
          }
        },
      };
    },
    inFlight(providerId, organisationId) {
      const base = `${CONCURRENCY_KEY_PREFIX}${providerId}`;
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
  return createRedisProviderConcurrencyLimiter({ client: makeClient(), limits, logger });
}
