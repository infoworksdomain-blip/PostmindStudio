// BACKLOG 2.10, spec 11.4: 5 failures within 60s opens a provider's breaker for 5 minutes;
// the router routes around it. After the open period one trial request is allowed
// (half-open): success closes the breaker, failure re-opens it for another 5 minutes. A trial
// slot that is claimed but never resolved is released explicitly (releaseTrial) or, as a
// backstop, expires after TRIAL_TIMEOUT_MS so a provider can never stay blocked forever.
//
// Failures caused by the request itself (invalid input, content policy) say nothing about
// provider health and are not counted (see CLIENT_SIDE_ERROR_CLASSES).
//
// BACKLOG 13.16: the state lives in Redis (circuit-breaker-redis.ts), so every worker and API
// process shares one breaker per provider. This in-memory store is kept for tests, for local
// runs without Redis (STUDIO_CIRCUIT_BREAKER_STORE=memory), and as the fail-safe fallback the
// Redis store uses while Redis is unreachable. Methods may return promises (Redis store);
// callers always await them.

export const FAILURE_THRESHOLD = 5;
export const FAILURE_WINDOW_MS = 60_000;
export const OPEN_DURATION_MS = 5 * 60_000;
/** An unresolved half-open trial is abandoned after this long, freeing the slot. */
export const TRIAL_TIMEOUT_MS = 15 * 60_000;

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * 20.11: why a provider is held out of routing for an account problem (bad key, no credits,
 * usage / spend limit) and until when. Shown in the Admin Centre provider health view.
 */
export interface AccountHold {
  errorClass: string;
  reason: string;
  /** ms since epoch: when the provider may be tried again (then one half-open trial). */
  until: number;
  /** ms since epoch: when the hold was placed. */
  since: number;
}

interface ProviderBreaker {
  failures: number[]; // timestamps within the window
  openedAt?: number;
  /** How long this opening lasts; undefined = OPEN_DURATION_MS (20.11 account holds differ). */
  openMs?: number;
  /** When the half-open trial slot was claimed; undefined = free. */
  trialStartedAt?: number;
  hold?: AccountHold;
}

export type Awaitable<T> = T | Promise<T>;

export interface CircuitBreaker {
  state(providerId: string): Awaitable<BreakerState>;
  /** True if a request may be sent now. In half-open, claims the single trial slot. */
  tryAcquire(providerId: string): Awaitable<boolean>;
  recordSuccess(providerId: string): Awaitable<void>;
  recordFailure(providerId: string): Awaitable<void>;
  /** Free a claimed trial slot whose request was never sent (e.g. aborted by the kill switch). */
  releaseTrial(providerId: string): Awaitable<void>;
  snapshot(): Awaitable<Record<string, BreakerState>>;
  /**
   * 20.11: open the breaker at once until `hold.until` for an account problem (no failure count:
   * retrying the same account cannot succeed). Optional so simple test doubles stay valid;
   * callers fall back to recordFailure.
   */
  tripAccount?(providerId: string, hold: Omit<AccountHold, 'since'>): Awaitable<void>;
  /** 20.11: the account holds still in force, by provider. */
  accountHolds?(): Awaitable<Record<string, AccountHold>>;
}

/** The in-memory store answers synchronously. */
export interface MemoryCircuitBreaker extends CircuitBreaker {
  state(providerId: string): BreakerState;
  tryAcquire(providerId: string): boolean;
  recordSuccess(providerId: string): void;
  recordFailure(providerId: string): void;
  releaseTrial(providerId: string): void;
  snapshot(): Record<string, BreakerState>;
  tripAccount(providerId: string, hold: Omit<AccountHold, 'since'>): void;
  accountHolds(): Record<string, AccountHold>;
}

/** Breaker state from the time it opened (shared by both stores). */
export function stateAt(
  openedAt: number | undefined,
  now: number,
  openMs: number = OPEN_DURATION_MS,
): BreakerState {
  if (openedAt === undefined) return 'closed';
  return now - openedAt >= openMs ? 'half_open' : 'open';
}

export function createCircuitBreaker(now: () => number = Date.now): MemoryCircuitBreaker {
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
    return stateAt(breaker?.openedAt, now(), breaker?.openMs);
  }

  function open(breaker: ProviderBreaker, openMs?: number): void {
    breaker.openedAt = now();
    breaker.openMs = openMs;
    breaker.failures = [];
    breaker.trialStartedAt = undefined;
    if (openMs === undefined) breaker.hold = undefined;
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
      breaker.openMs = undefined;
      breaker.failures = [];
      breaker.trialStartedAt = undefined;
      breaker.hold = undefined;
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
    tripAccount(providerId, hold) {
      const breaker = get(providerId);
      const since = now();
      open(breaker, Math.max(0, hold.until - since));
      breaker.hold = { ...hold, since };
    },
    accountHolds() {
      const t = now();
      return Object.fromEntries(
        [...breakers.entries()]
          .filter(([, b]) => b.hold !== undefined && b.hold.until > t)
          .map(([id, b]) => [id, b.hold as AccountHold]),
      );
    },
  };
}

let processBreaker: CircuitBreaker | undefined;

/** Test hook: install a breaker (pass undefined to reset). */
export function setCircuitBreaker(next: CircuitBreaker | undefined): void {
  processBreaker = next;
}

/** This process's breaker, built once by `factory` (the shared Redis store in production). */
export function getCircuitBreaker(
  factory: () => CircuitBreaker = () => createCircuitBreaker(),
): CircuitBreaker {
  processBreaker ??= factory();
  return processBreaker;
}
