import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import {
  ACCOUNT_HOLD_MAX_MS,
  ACCOUNT_HOLD_MS,
  accountHoldUntil,
  isAccountErrorClass,
  isAccountProviderError,
  parseRegainAt,
  retryAtOf,
} from './account-errors';

describe('account errors (20.11)', () => {
  it('recognises the account classes only', () => {
    for (const c of ['auth', 'insufficient_credits', 'account_limit'])
      expect(isAccountErrorClass(c)).toBe(true);
    for (const c of ['rate_limited', 'invalid_request', 'timeout', undefined, null])
      expect(isAccountErrorClass(c)).toBe(false);
    expect(isAccountProviderError(new ProviderError('x', 'auth', 'm', false))).toBe(true);
    expect(isAccountProviderError(new ProviderError('x', 'timeout', 'm', true))).toBe(false);
  });

  it('reads the resume time Anthropic states (platform.claude.com/docs/en/api/rate-limits)', () => {
    expect(
      parseRegainAt(
        'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
      )?.toISOString(),
    ).toBe('2026-10-01T00:00:00.000Z');
    expect(parseRegainAt('Number of requests has exceeded your rate limit')).toBeUndefined();
  });

  it('holds until the stated time, else 15 minutes, never more than 32 days', () => {
    const now = Date.parse('2026-09-30T18:00:00Z');
    expect(accountHoldUntil(now, '2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(accountHoldUntil(now)).toBe(now + ACCOUNT_HOLD_MS);
    expect(accountHoldUntil(now, '2026-09-30T17:00:00Z')).toBe(now + ACCOUNT_HOLD_MS); // past
    expect(accountHoldUntil(now, 'not a date')).toBe(now + ACCOUNT_HOLD_MS);
    expect(accountHoldUntil(now, '2027-09-30T00:00:00Z')).toBe(now + ACCOUNT_HOLD_MAX_MS);
  });

  it('takes retryAt from a ProviderError', () => {
    const err = new ProviderError('anthropic', 'account_limit', 'm', false, { retryAt: 'x' });
    expect(retryAtOf(err)).toBe('x');
    expect(retryAtOf(new Error('m'))).toBeUndefined();
  });
});
