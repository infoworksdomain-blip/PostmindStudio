import { ProviderError, RateDeferredError } from '../../errors';

// 20.29 (load test) — a provider that answers "too many requests" (HTTP 429, Kling 1302 / 1303
// "concurrency over the pack limit", Gemini RESOURCE_EXHAUSTED without a quota failure: all
// classified `rate_limited`) is busy, not broken. Before 20.29 such an answer spent one of the
// job's 6 attempts (5 s → 80 s backoff), so a burst of videos could use up every attempt within
// about 2.5 minutes and fail its shots. Now the job is DELAYED instead (the same path as a full
// 15.C3 rate window or a 20.29 concurrency cap: no attempt spent), with a jittered exponential
// wait, up to MAX_RATE_DEFERRALS times (about 10 minutes in all). After that the answer counts as
// an ordinary retryable failure again, so a provider that throttles for good still ends in the
// normal retry → failover (open breaker) → dead-letter path.
//
// The circuit breaker still counts these answers (tracked.ts): with the per-provider concurrency
// caps (providers/provider-concurrency.ts) set to the account's real limits they are rare, and a
// provider that keeps refusing should be routed around.

export const MAX_RATE_DEFERRALS = 8;
export const RATE_BACKOFF_BASE_MS = 10_000;
export const RATE_BACKOFF_CAP_MS = 120_000;

/** Wait before deferral n + 1 (n = deferrals so far): 10 s, 20 s, 40 s… capped at 2 min, ±25 %. */
export function rateBackoffMs(deferrals: number, random: () => number = Math.random): number {
  const base = Math.min(RATE_BACKOFF_BASE_MS * 2 ** Math.max(0, deferrals), RATE_BACKOFF_CAP_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * The deferral for an error, if the job should wait rather than fail: a RateDeferredError as is
 * (rate window, concurrency cap), or a provider's `rate_limited` answer while the job has been
 * deferred fewer than MAX_RATE_DEFERRALS times. `deferrals` = times this job was already delayed.
 */
export function deferralFor(
  err: unknown,
  deferrals: number,
  random: () => number = Math.random,
): RateDeferredError | undefined {
  if (err instanceof RateDeferredError) return err;
  if (
    err instanceof ProviderError &&
    err.errorClass === 'rate_limited' &&
    deferrals < MAX_RATE_DEFERRALS
  ) {
    return new RateDeferredError(err.providerId, rateBackoffMs(deferrals, random), {
      reason: 'provider_rate_limited',
      deferrals: deferrals + 1,
    });
  }
  return undefined;
}

/**
 * How many times a BullMQ job has been delayed: every move to active increments attemptsStarted,
 * a failure also increments attemptsMade, a deferral (moveToDelayed + DelayedError) does not.
 */
export function deferralsOf(job: { attemptsStarted?: number; attemptsMade: number }): number {
  return Math.max(0, (job.attemptsStarted ?? 0) - job.attemptsMade - 1);
}
