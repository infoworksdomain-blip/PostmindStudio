import type { Logger } from 'pino';
import type { RateRedisClient } from './provider-rate';

// BACKLOG 23.1 — wake a provider job waiting between polls. The render callback route (web
// process) sets a short-lived Redis flag for the provider job once it has confirmed with the
// provider that the job ended; the worker waiting in provider-run.ts checks the flag every
// WAKE_CHECK_MS while it waits for its next (now longer) poll and polls at once when it is set.
// A lost callback costs nothing but time: the worker still polls at its fallback interval.
//
//   studio:pwake:<provider>:<providerJobId>   STRING "1", expires after WAKE_TTL_MS
//
// Fail-open: a Redis error reads as "not woken" (the fallback poll still runs).

export const WAKE_KEY_PREFIX = 'studio:pwake:';
/** How often a waiting job looks for its wake flag. */
export const WAKE_CHECK_MS = 1_000;
/** A wake flag outlives the longest fallback wait. */
export const WAKE_TTL_MS = 15 * 60_000;
const WARN_INTERVAL_MS = 60_000;

export interface ProviderWake {
  /** Mark the provider job as ready to poll. */
  signal(providerId: string, providerJobId: string): Promise<void>;
  /** True (once) when the job was signalled since the last call. */
  consume(providerId: string, providerJobId: string): Promise<boolean>;
}

export function wakeKey(providerId: string, providerJobId: string): string {
  return `${WAKE_KEY_PREFIX}${providerId}:${providerJobId}`;
}

const SIGNAL_SCRIPT = `redis.call('SET', KEYS[1], '1', 'PX', ARGV[1]) return 1`;
// GET + DEL in one step (GETDEL needs Redis 6.2).
const CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) return 1 end
return 0`;

export function createRedisProviderWake(deps: {
  client: RateRedisClient;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
}): ProviderWake {
  const now = deps.now ?? Date.now;
  let lastWarnAt = -Infinity;
  const warn = (err: unknown, what: string) => {
    if (now() - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = now();
    deps.logger.warn({ err }, `provider wake unavailable (${what})`);
  };
  return {
    async signal(providerId, providerJobId) {
      await deps.client.eval(
        SIGNAL_SCRIPT,
        1,
        wakeKey(providerId, providerJobId),
        String(WAKE_TTL_MS),
      );
    },
    async consume(providerId, providerJobId) {
      try {
        const reply = await deps.client.eval(CONSUME_SCRIPT, 1, wakeKey(providerId, providerJobId));
        return Number(reply) === 1;
      } catch (err) {
        warn(err, 'consume');
        return false;
      }
    },
  };
}

/** In-process wake flags (tests, single-process tools). */
export function createMemoryProviderWake(): ProviderWake & { pending(): string[] } {
  let flags: ReadonlySet<string> = new Set();
  return {
    async signal(providerId, providerJobId) {
      flags = new Set([...flags, wakeKey(providerId, providerJobId)]);
    },
    async consume(providerId, providerJobId) {
      const key = wakeKey(providerId, providerJobId);
      if (!flags.has(key)) return false;
      flags = new Set([...flags].filter((k) => k !== key));
      return true;
    },
    pending: () => [...flags],
  };
}

/** Redis-backed wake flags whenever REDIS_URL is set; undefined without Redis (polling only). */
export function providerWakeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  makeClient: () => RateRedisClient,
  logger: Pick<Logger, 'warn'>,
): ProviderWake | undefined {
  if (!env.REDIS_URL?.trim()) return undefined;
  return createRedisProviderWake({ client: makeClient(), logger });
}

/**
 * Wait up to `totalMs` before the next poll, returning early (true) once the job is woken.
 * Without a wake signal this is one plain sleep.
 */
export async function waitForNextPoll(
  deps: { sleep: (ms: number) => Promise<void>; wake?: ProviderWake },
  job: { providerId: string; providerJobId: string },
  totalMs: number,
  checkMs: number = WAKE_CHECK_MS,
): Promise<boolean> {
  if (!deps.wake) {
    await deps.sleep(totalMs);
    return false;
  }
  for (let waited = 0; waited < totalMs; waited += checkMs) {
    if (await deps.wake.consume(job.providerId, job.providerJobId)) return true;
    await deps.sleep(Math.min(checkMs, totalMs - waited));
  }
  return deps.wake.consume(job.providerId, job.providerJobId);
}
