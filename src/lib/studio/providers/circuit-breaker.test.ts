import { describe, expect, it } from 'vitest';
import {
  createCircuitBreaker,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  OPEN_DURATION_MS,
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
