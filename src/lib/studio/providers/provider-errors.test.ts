import { describe, expect, it } from 'vitest';
import { classifyHttpFailure, isOutOfCreditMessage } from './provider-errors';

// 20.19 — out-of-credit wording on an input-error status is an account problem.

describe('isOutOfCreditMessage', () => {
  it.each([
    'You do not have enough credits to run this task.', // Runway, production 2026-10-02
    "Insufficient credit. This operation requires 'api' credits.", // HeyGen, production
    'Not enough credits',
    'Your account has insufficient balance',
    'insufficient funds on the account',
    'You are out of credits.',
    'Credit balance is exhausted',
    // Shotstack render status, production 2026-10-05
    "Your render request could not be processed because it exceeds one or more plan limits. '0.28' credits required, you have '0.01' credits left.",
  ])('recognises %j', (message) => {
    expect(isOutOfCreditMessage(message)).toBe(true);
  });

  it.each([
    'Invalid ratio for this model',
    'promptText must be at most 1000 characters',
    'credits must be a positive integer',
    'Render exceeds the maximum duration for your plan',
    '',
    undefined,
  ])('ignores %j', (message) => {
    expect(isOutOfCreditMessage(message)).toBe(false);
  });
});

describe('classifyHttpFailure', () => {
  it('upgrades a 400 / 422 with out-of-credit wording to insufficient_credits', () => {
    for (const status of [400, 404, 422]) {
      expect(
        classifyHttpFailure(status, 'You do not have enough credits to run this task.'),
      ).toEqual({ errorClass: 'insufficient_credits', retryable: false });
    }
  });

  it("keeps the status class otherwise, and an adapter's documented refinement always", () => {
    expect(classifyHttpFailure(400, 'bad ratio')).toEqual({
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(classifyHttpFailure(429, 'not enough credits')).toEqual({
      errorClass: 'rate_limited',
      retryable: true,
    });
    expect(classifyHttpFailure(401, 'not enough credits')).toEqual({
      errorClass: 'auth',
      retryable: false,
    });
    expect(
      classifyHttpFailure(400, 'not enough credits', {
        errorClass: 'content_policy',
        retryable: false,
      }),
    ).toEqual({ errorClass: 'content_policy', retryable: false });
  });
});
