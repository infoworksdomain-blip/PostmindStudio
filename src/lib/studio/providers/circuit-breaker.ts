// BACKLOG 2.10, spec 11.4: 5 failures within 60s opens a provider's breaker for 5 minutes;
// the router routes around it. After the open period one trial request is allowed
// (half-open): success closes the breaker, failure re-opens it for another 5 minutes. A trial
// slot that is claimed but never resolved is released explicitly (releaseTrial) or, as a
// backstop, expires after TRIAL_TIMEOUT_MS so a provider can never stay blocked forever.
//
// Failures caused by the request itself (invalid input, content policy) say nothing about
// provider health and are not counted (see CLIENT_SIDE_ERROR_CLASSES).
//
// State is per process. With several worker pods each pod trips independently, which still
// routes around a failing provider, just slightly later. Moving this state to Redis is
// planned with the queue work in Phase 3 (BACKLOG 3.1).

export const FAILURE_THRESHOLD = 5;
export const FAILURE_WINDOW_MS = 60_000;
export const OPEN_DURATION_MS = 5 * 60_000;
/** An unresolved half-open trial is abandoned after this long, freeing the slot. */
export const TRIAL_TIMEOUT_MS = 15 * 60_000;

export type BreakerState = 'closed' | 'open' | 'half_open';

interface ProviderBreaker {
  failures: number[]; // timestamps within the window
  openedAt?: number;
  /** When the half-open trial slot was claimed; undefined = free. */
  trialStartedAt?: number;
}

export interface CircuitBreaker {
  state(providerId: string): BreakerState;
  /** True if a request may be sent now. In half-open, claims the single trial slot. */
  tryAcquire(providerId: string): boolean;
  recordSuccess(providerId: string): void;
  recordFailure(providerId: string): void;
  /** Free a claimed trial slot whose request was never sent (e.g. aborted by the kill switch). */
  releaseTrial(providerId: string): void;
  snapshot(): Record<string, BreakerState>;
}

export function createCircuitBreaker(now: () => number = Date.now): CircuitBreaker {
  const breakers = new Map<string, ProviderBreaker>();

  function get(providerId: string): ProviderBreaker {
    let breaker = breakers.get(providerId);
    if (!breaker) {
      breaker = { failures: [] };
      breakers.set(providerId, breaker);
    }
    return breaker;
  }

  function state(providerId: string): BreakerState {
    const breaker = breakers.get(providerId);
    if (breaker?.openedAt === undefined) return 'closed';
    return now() - breaker.openedAt >= OPEN_DURATION_MS ? 'half_open' : 'open';
  }

  function open(breaker: ProviderBreaker): void {
    breaker.openedAt = now();
    breaker.failures = [];
    breaker.trialStartedAt = undefined;
  }

  return {
    state,
    tryAcquire(providerId) {
      const current = state(providerId);
      if (current === 'closed') return true;
      if (current === 'open') return false;
      const breaker = get(providerId);
      const trialLive =
        breaker.trialStartedAt !== undefined && now() - breaker.trialStartedAt < TRIAL_TIMEOUT_MS;
      if (trialLive) return false;
      breaker.trialStartedAt = now();
      return true;
    },
    recordSuccess(providerId) {
      const breaker = get(providerId);
      breaker.openedAt = undefined;
      breaker.failures = [];
      breaker.trialStartedAt = undefined;
    },
    recordFailure(providerId) {
      const breaker = get(providerId);
      const current = state(providerId);
      if (current === 'half_open') return open(breaker);
      if (current === 'open') return;
      const cutoff = now() - FAILURE_WINDOW_MS;
      breaker.failures = [...breaker.failures.filter((t) => t > cutoff), now()];
      if (breaker.failures.length >= FAILURE_THRESHOLD) open(breaker);
    },
    releaseTrial(providerId) {
      const breaker = breakers.get(providerId);
      if (breaker) breaker.trialStartedAt = undefined;
    },
    snapshot() {
      return Object.fromEntries([...breakers.keys()].map((id) => [id, state(id)]));
    },
  };
}

let processBreaker: CircuitBreaker | undefined;

export function getCircuitBreaker(): CircuitBreaker {
  processBreaker ??= createCircuitBreaker();
  return processBreaker;
}
