import { APIError } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import {
  enforceLimits,
  INVITE_INVITER_RULE,
  INVITE_ORGANISATION_RULE,
  inviteChecks,
  TWO_FACTOR_ACCOUNT_RULE,
  TWO_FACTOR_VERIFY_PATHS,
  twoFactorChecks,
} from './account-rate-limits';
import { createMemoryAuthRateLimitStore } from './rate-limit-store';

// Phase 19.3: account-, organisation- and inviter-keyed limits (no client IP in any key).

async function attempts(n: number, run: () => Promise<void>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) {
    try {
      await run();
      statuses.push(200);
    } catch (err) {
      statuses.push(err instanceof APIError ? err.statusCode : 500);
    }
  }
  return statuses;
}

describe('account rate limits', () => {
  it('covers every second-factor verify endpoint', () => {
    expect([...TWO_FACTOR_VERIFY_PATHS].sort()).toEqual([
      '/two-factor/verify-backup-code',
      '/two-factor/verify-otp',
      '/two-factor/verify-totp',
    ]);
  });

  it('allows 5 second-factor attempts per account per 10 minutes, then 429 with Retry-After', async () => {
    let t = 0;
    const store = createMemoryAuthRateLimitStore(() => t);
    const statuses = await attempts(6, () => enforceLimits(store, twoFactorChecks('u1')));
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const err = await enforceLimits(store, twoFactorChecks('u1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(new Headers((err as APIError).headers).get('X-Retry-After')).toBe('600');
    // Another account is unaffected; the window resets.
    await expect(enforceLimits(store, twoFactorChecks('u2'))).resolves.toBeUndefined();
    t += TWO_FACTOR_ACCOUNT_RULE.window * 1000;
    await expect(enforceLimits(store, twoFactorChecks('u1'))).resolves.toBeUndefined();
  });

  it('charges the organisation only for members, and always the inviter', () => {
    expect(inviteChecks({ inviterId: 'u1', organisationId: 'o1', isMember: true })).toEqual([
      { key: 'invite:org:o1', rule: INVITE_ORGANISATION_RULE },
      { key: 'invite:inviter:u1', rule: INVITE_INVITER_RULE },
    ]);
    expect(inviteChecks({ inviterId: 'u1', organisationId: 'o1', isMember: false })).toEqual([
      { key: 'invite:inviter:u1', rule: INVITE_INVITER_RULE },
    ]);
    expect(inviteChecks({ inviterId: 'u1', organisationId: null, isMember: false })).toHaveLength(
      1,
    );
  });

  it('caps an organisation at 20 invitations an hour, shared by all its inviters', async () => {
    const store = createMemoryAuthRateLimitStore(() => 0);
    const statuses = await attempts(21, async () => {
      const inviter = `u${Math.floor(Math.random() * 1e9)}`;
      await enforceLimits(
        store,
        inviteChecks({ inviterId: inviter, organisationId: 'o1', isMember: true }),
      );
    });
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses[20]).toBe(429);
  });

  it('caps one inviter at 30 an hour across organisations', async () => {
    const store = createMemoryAuthRateLimitStore(() => 0);
    let org = 0;
    const statuses = await attempts(31, async () => {
      org += 1;
      await enforceLimits(
        store,
        inviteChecks({ inviterId: 'u1', organisationId: `o${org}`, isMember: true }),
      );
    });
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses[30]).toBe(429);
  });

  it('does not charge the inviter when the organisation is already full', async () => {
    const store = createMemoryAuthRateLimitStore(() => 0);
    for (let i = 0; i < 20; i += 1) {
      await enforceLimits(
        store,
        inviteChecks({ inviterId: `x${i}`, organisationId: 'o1', isMember: true }),
      );
    }
    await attempts(5, () =>
      enforceLimits(store, inviteChecks({ inviterId: 'u1', organisationId: 'o1', isMember: true })),
    );
    // u1's own budget is untouched: 30 more in other organisations still pass.
    const other = await attempts(30, () =>
      enforceLimits(
        store,
        inviteChecks({ inviterId: 'u1', organisationId: null, isMember: false }),
      ),
    );
    expect(other.every((s) => s === 200)).toBe(true);
  });
});
