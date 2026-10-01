import { randomUUID } from 'node:crypto';
import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ConfigurationError } from '../../errors';
import { logger as rootLogger } from '../../logger';
import { redisConnectionFromEnv } from '../queue/redis';
import {
  createCircuitBreaker,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  getCircuitBreaker,
  OPEN_DURATION_MS,
  stateAt,
  TRIAL_TIMEOUT_MS,
  type AccountHold,
  type BreakerState,
  type CircuitBreaker,
  type MemoryCircuitBreaker,
} from './circuit-breaker';

// BACKLOG 13.16 — the provider circuit breaker (spec 11.4, BACKLOG 2.10) shared through Redis,
// so every worker and API process sees the same state: five failures anywhere open the breaker
// for every process, and there is one half-open trial platform-wide.
//
// Keys (Studio's Redis DB 3):
//   studio:breaker:<provider>            HASH  openedAt, trialStartedAt (ms since epoch); 20.11
//                                              account holds add openMs, holdClass, holdReason,
//                                              holdUntil, holdSince
//   studio:breaker:<provider>:failures   ZSET  failure timestamps inside the 60 s window
//   studio:breaker:providers             SET   providers ever recorded (snapshot / admin)
// Every read-modify-write is one Lua script (atomic; Redis >= 2.6). Times come from the
// caller's clock as arguments, so the scripts are deterministic.
//
// Fail-safe: when Redis errors or times out, the operation falls back to an in-memory breaker
// in this process (the pre-13.16 behaviour: each process trips on its own) and a warning is
// logged at most once a minute. A Redis outage therefore never blocks every provider, and never
// lets a failing provider be hammered: the local breaker still opens after 5 local failures.
// Successes and failures are always mirrored into the local breaker, so it is warm when needed.

export const BREAKER_KEY_PREFIX = 'studio:breaker:';
export const BREAKER_PROVIDERS_KEY = `${BREAKER_KEY_PREFIX}providers`;
const WARN_INTERVAL_MS = 60_000;

const stateKey = (providerId: string) => `${BREAKER_KEY_PREFIX}${providerId}`;
const failuresKey = (providerId: string) => `${BREAKER_KEY_PREFIX}${providerId}:failures`;

// KEYS: state hash. ARGV: now, open duration, trial timeout. 1 = may send, 0 = blocked.
// A 20.11 account hold stores its own open duration (openMs).
const TRY_ACQUIRE = `
local opened = redis.call('HGET', KEYS[1], 'openedAt')
if not opened then return 1 end
local now = tonumber(ARGV[1])
local openMs = tonumber(redis.call('HGET', KEYS[1], 'openMs') or ARGV[2])
if now - tonumber(opened) < openMs then return 0 end
local trial = redis.call('HGET', KEYS[1], 'trialStartedAt')
if trial and now - tonumber(trial) < tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], 'trialStartedAt', ARGV[1])
return 1`;

// KEYS: state hash, failures zset, providers set. ARGV: now, open duration, window, threshold,
// unique member, provider id. Returns 2 = opened now, 1 = already open, 0 = still closed.
const RECORD_FAILURE = `
redis.call('SADD', KEYS[3], ARGV[6])
local now = tonumber(ARGV[1])
local opened = redis.call('HGET', KEYS[1], 'openedAt')
if opened then
  local openMs = tonumber(redis.call('HGET', KEYS[1], 'openMs') or ARGV[2])
  if now - tonumber(opened) >= openMs then
    redis.call('HSET', KEYS[1], 'openedAt', ARGV[1])
    redis.call('HDEL', KEYS[1], 'trialStartedAt', 'openMs', 'holdClass', 'holdReason', 'holdUntil', 'holdSince')
    redis.call('DEL', KEYS[2])
    return 2
  end
  return 1
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[3]))
redis.call('ZADD', KEYS[2], now, ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then
  redis.call('HSET', KEYS[1], 'openedAt', ARGV[1])
  redis.call('HDEL', KEYS[1], 'trialStartedAt', 'openMs', 'holdClass', 'holdReason', 'holdUntil', 'holdSince')
  redis.call('DEL', KEYS[2])
  return 2
end
return 0`;

// 20.11 — KEYS: state hash, failures zset, providers set. ARGV: now, open ms, error class,
// reason, until, provider id. Opens the breaker at once for an account hold. HMSET (not a
// multi-field HSET) keeps Redis < 4 working.
const TRIP_ACCOUNT = `
redis.call('SADD', KEYS[3], ARGV[6])
redis.call('HDEL', KEYS[1], 'trialStartedAt')
redis.call('HMSET', KEYS[1], 'openedAt', ARGV[1], 'openMs', ARGV[2], 'holdClass', ARGV[3],
  'holdReason', ARGV[4], 'holdUntil', ARGV[5], 'holdSince', ARGV[1])
redis.call('DEL', KEYS[2])
return 1`;

/** The Redis commands the store uses (ioredis satisfies it; tests may pass a failing double). */
export interface BreakerRedisClient {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

export interface RedisBreakerDeps {
  client: BreakerRedisClient;
  now?: () => number;
  logger?: Logger;
  /** Used while Redis is unreachable; defaults to a fresh in-memory breaker. */
  fallback?: MemoryCircuitBreaker;
}

export function createRedisCircuitBreaker(deps: RedisBreakerDeps): CircuitBreaker {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? rootLogger;
  const local = deps.fallback ?? createCircuitBreaker(now);
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  async function shared<T>(op: string, run: () => Promise<T>, fallback: () => T): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (now() - lastWarnAt >= WARN_INTERVAL_MS) {
        lastWarnAt = now();
        log.warn({ err, op }, 'circuit breaker: Redis unavailable, using this process state');
      }
      return fallback();
    }
  }

  const numberField = async (providerId: string, field: string) => {
    const raw = await deps.client.hget(stateKey(providerId), field);
    return raw === null || raw === undefined ? undefined : Number(raw);
  };
  const stateOf = async (providerId: string) =>
    stateAt(
      await numberField(providerId, 'openedAt'),
      now(),
      await numberField(providerId, 'openMs'),
    );
  const holdOf = async (providerId: string): Promise<AccountHold | undefined> => {
    const until = await numberField(providerId, 'holdUntil');
    if (until === undefined || !(until > now())) return undefined;
    const key = stateKey(providerId);
    return {
      errorClass: (await deps.client.hget(key, 'holdClass')) ?? 'unknown',
      reason: (await deps.client.hget(key, 'holdReason')) ?? '',
      until,
      since: (await numberField(providerId, 'holdSince')) ?? until,
    };
  };

  return {
    state(providerId) {
      return shared(
        'state',
        async () => stateOf(providerId),
        () => local.state(providerId),
      );
    },
    tryAcquire(providerId) {
      return shared(
        'tryAcquire',
        async () => {
          const allowed = await deps.client.eval(
            TRY_ACQUIRE,
            1,
            stateKey(providerId),
            String(now()),
            String(OPEN_DURATION_MS),
            String(TRIAL_TIMEOUT_MS),
          );
          return Number(allowed) === 1;
        },
        () => local.tryAcquire(providerId),
      );
    },
    recordSuccess(providerId) {
      local.recordSuccess(providerId);
      return shared(
        'recordSuccess',
        async () => {
          await deps.client.sadd(BREAKER_PROVIDERS_KEY, providerId);
          await deps.client.del(stateKey(providerId), failuresKey(providerId));
        },
        () => undefined,
      );
    },
    recordFailure(providerId) {
      local.recordFailure(providerId);
      return shared(
        'recordFailure',
        async () => {
          await deps.client.eval(
            RECORD_FAILURE,
            3,
            stateKey(providerId),
            failuresKey(providerId),
            BREAKER_PROVIDERS_KEY,
            String(now()),
            String(OPEN_DURATION_MS),
            String(FAILURE_WINDOW_MS),
            String(FAILURE_THRESHOLD),
            `${now()}:${randomUUID()}`,
            providerId,
          );
        },
        () => undefined,
      );
    },
    releaseTrial(providerId) {
      local.releaseTrial(providerId);
      return shared(
        'releaseTrial',
        async () => {
          await deps.client.hdel(stateKey(providerId), 'trialStartedAt');
        },
        () => undefined,
      );
    },
    snapshot() {
      return shared(
        'snapshot',
        async () => {
          const ids = await deps.client.smembers(BREAKER_PROVIDERS_KEY);
          const states = await Promise.all(
            ids.map(async (id): Promise<[string, BreakerState]> => [id, await stateOf(id)]),
          );
          return Object.fromEntries(states.sort(([a], [b]) => a.localeCompare(b)));
        },
        () => local.snapshot(),
      );
    },
    tripAccount(providerId, hold) {
      local.tripAccount(providerId, hold);
      return shared(
        'tripAccount',
        async () => {
          await deps.client.eval(
            TRIP_ACCOUNT,
            3,
            stateKey(providerId),
            failuresKey(providerId),
            BREAKER_PROVIDERS_KEY,
            String(now()),
            String(Math.max(0, hold.until - now())),
            hold.errorClass,
            hold.reason,
            String(hold.until),
            providerId,
          );
        },
        () => undefined,
      );
    },
    accountHolds() {
      return shared(
        'accountHolds',
        async () => {
          const ids = await deps.client.smembers(BREAKER_PROVIDERS_KEY);
          const holds = await Promise.all(
            ids.map(async (id): Promise<[string, AccountHold | undefined]> => [
              id,
              await holdOf(id),
            ]),
          );
          return Object.fromEntries(
            holds.filter((entry): entry is [string, AccountHold] => entry[1] !== undefined),
          );
        },
        () => local.accountHolds(),
      );
    },
  };
}

/** A dedicated ioredis client that fails fast (never queues commands while Redis is down). */
export function createBreakerRedisClient(connection: ConnectionOptions): Redis {
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

export type BreakerStore = 'redis' | 'memory';

/** STUDIO_CIRCUIT_BREAKER_STORE: "redis" (default when REDIS_URL is set) or "memory". */
export function breakerStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): BreakerStore {
  const raw = env.STUDIO_CIRCUIT_BREAKER_STORE?.trim().toLowerCase() ?? '';
  if (raw === '') return env.REDIS_URL?.trim() ? 'redis' : 'memory';
  if (raw === 'redis' || raw === 'memory') return raw;
  throw new ConfigurationError('STUDIO_CIRCUIT_BREAKER_STORE must be "redis" or "memory"');
}

/** This process's breaker: shared through Redis unless configured (or forced) to memory. */
export function getSharedCircuitBreaker(): CircuitBreaker {
  return getCircuitBreaker(() =>
    breakerStoreFromEnv() === 'redis'
      ? createRedisCircuitBreaker({ client: createBreakerRedisClient(redisConnectionFromEnv()) })
      : createCircuitBreaker(),
  );
}
