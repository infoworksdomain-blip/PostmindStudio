import { describe, expect, it } from 'vitest';
import {
  createCircuitBreaker,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  OPEN_DURATION_MS,
  TRIAL_TIMEOUT_MS,
} from './circuit-breaker';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function failTimes(breaker: ReturnType<typeof createCircuitBreaker>, id: string, n: number) {
  for (let i = 0; i < n; i += 1) breaker.recordFailure(id);
}

describe('circuit breaker (spec 11.4: 5 failures in 60s → open 5 min)', () => {
  it('uses the spec thresholds', () => {
    expect([FAILURE_THRESHOLD, FAILURE_WINDOW_MS, OPEN_DURATION_MS]).toEqual([5, 60_000, 300_000]);
  });

  it('stays closed below the threshold', () => {
    const breaker = createCircuitBreaker(clock().now);
    failTimes(breaker, 'runway', 4);
    expect(breaker.state('runway')).toBe('closed');
    expect(breaker.tryAcquire('runway')).toBe(true);
  });

  it('opens on the 5th failure within 60s and blocks requests', () => {
    const breaker = createCircuitBreaker(clock().now);
    failTimes(breaker, 'runway', 5);
    expect(breaker.state('runway')).toBe('open');
    expect(breaker.tryAcquire('runway')).toBe(false);
    expect(breaker.state('luma')).toBe('closed');
  });

  it('ignores failures older than the 60s window', () => {
    const c = clock();
    const breaker = createCircuitBreaker(c.now);
    failTimes(breaker, 'runway', 4);
    c.advance(60_001);
    breaker.recordFailure('runway');
    expect(breaker.state('runway')).toBe('closed');
  });

  it('moves to half-open after 5 minutes and allows exactly one trial', () => {
    const c = clock();
    const breaker = createCircuitBreaker(c.now);
    failTimes(breaker, 'runway', 5);
    c.advance(OPEN_DURATION_MS - 1);
    expect(breaker.state('runway')).toBe('open');
    c.advance(1);
    expect(breaker.state('runway')).toBe('half_open');
    expect(breaker.tryAcquire('runway')).toBe(true);
    expect(breaker.tryAcquire('runway')).toBe(false);
  });

  it('closes when the half-open trial succeeds', () => {
    const c = clock();
    const breaker = createCircuitBreaker(c.now);
    failTimes(breaker, 'runway', 5);
    c.advance(OPEN_DURATION_MS);
    breaker.tryAcquire('runway');
    breaker.recordSuccess('runway');
    expect(breaker.state('runway')).toBe('closed');
    failTimes(breaker, 'runway', 4);
    expect(breaker.state('runway')).toBe('closed');
  });

  it('re-opens for another 5 minutes when the trial fails', () => {
    const c = clock();
    const breaker = createCircuitBreaker(c.now);
    failTimes(breaker, 'runway', 5);
    c.advance(OPEN_DURATION_MS);
    breaker.tryAcquire('runway');
    breaker.recordFailure('runway');
    expect(breaker.state('runway')).toBe('open');
    c.advance(OPEN_DURATION_MS - 1);
    expect(breaker.state('runway')).toBe('open');
  });

  it('ignores extra failures while open and reports a snapshot', () => {
    const breaker = createCircuitBreaker(clock().now);
    failTimes(breaker, 'runway', 7);
    breaker.recordSuccess('luma');
    expect(breaker.snapshot()).toEqual({ runway: 'open', luma: 'closed' });
  });
});

describe('half-open trial slot hygiene', () => {
  it('releaseTrial frees a claimed slot without changing state', () => {
    let t = 0;
    const breaker = createCircuitBreaker(() => t);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('runway');
    t = OPEN_DURATION_MS;
    expect(breaker.tryAcquire('runway')).toBe(true);
    expect(breaker.tryAcquire('runway')).toBe(false);
    breaker.releaseTrial('runway');
    expect(breaker.state('runway')).toBe('half_open');
    expect(breaker.tryAcquire('runway')).toBe(true);
    breaker.releaseTrial('unknown-provider');
  });

  it('expires an abandoned trial after TRIAL_TIMEOUT_MS', () => {
    let t = 0;
    const breaker = createCircuitBreaker(() => t);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('runway');
    t = OPEN_DURATION_MS;
    breaker.tryAcquire('runway');
    t += TRIAL_TIMEOUT_MS - 1;
    expect(breaker.tryAcquire('runway')).toBe(false);
    t += 1;
    expect(breaker.tryAcquire('runway')).toBe(true);
  });
});

describe('account holds (20.11)', () => {
  it('opens at once until the hold ends, then allows one trial; success clears the hold', () => {
    let t = 1_000;
    const breaker = createCircuitBreaker(() => t);
    const until = t + 6 * 60 * 60_000; // e.g. Anthropic "regain access … at 00:00 UTC"
    breaker.tripAccount('anthropic', {
      errorClass: 'account_limit',
      reason: 'usage limits',
      until,
    });
    expect(breaker.state('anthropic')).toBe('open');
    expect(breaker.tryAcquire('anthropic')).toBe(false);
    expect(breaker.accountHolds()).toEqual({
      anthropic: { errorClass: 'account_limit', reason: 'usage limits', until, since: 1_000 },
    });
    // Well past the normal 5-minute open period, still held.
    t += OPEN_DURATION_MS * 10;
    expect(breaker.tryAcquire('anthropic')).toBe(false);
    t = until;
    expect(breaker.state('anthropic')).toBe('half_open');
    expect(breaker.accountHolds()).toEqual({});
    expect(breaker.tryAcquire('anthropic')).toBe(true);
    breaker.recordSuccess('anthropic');
    expect(breaker.state('anthropic')).toBe('closed');
  });

  it('a failed trial after a hold re-opens for the normal period and drops the hold', () => {
    let t = 0;
    const breaker = createCircuitBreaker(() => t);
    breaker.tripAccount('openai', { errorClass: 'auth', reason: 'bad key', until: 60_000 });
    t = 60_000;
    expect(breaker.tryAcquire('openai')).toBe(true);
    breaker.recordFailure('openai');
    expect(breaker.state('openai')).toBe('open');
    t += OPEN_DURATION_MS;
    expect(breaker.state('openai')).toBe('half_open');
  });
});
