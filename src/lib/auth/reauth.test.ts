import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../errors';
import { verifyAccountPassword } from './reauth';
import type { SignedInSession } from './session-route';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const session = (createdAt: number): SignedInSession => ({
  session: { id: 's', token: 't', createdAt: new Date(createdAt) },
  user: { id: 'u1', email: 'a@b.co', name: 'A', emailVerified: true },
});
const hasher = { hash: vi.fn(), verify: vi.fn(async ({ password }) => password === 'right one') };

describe('verifyAccountPassword (Phase 18 §5.11)', () => {
  const withPassword = { account: { findFirst: vi.fn(async () => ({ password: 'hash' })) } };
  const googleOnly = { account: { findFirst: vi.fn(async () => null) } };

  it('needs the right password when the account has one', async () => {
    await expect(
      verifyAccountPassword(withPassword as never, session(0), 'right one', NOW, hasher),
    ).resolves.toBeUndefined();
    for (const pw of ['wrong', '', undefined]) {
      await expect(
        verifyAccountPassword(withPassword as never, session(NOW), pw, NOW, hasher),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('needs a sign-in in the last 15 minutes when the account has no password', async () => {
    await expect(
      verifyAccountPassword(googleOnly as never, session(NOW - 60_000), undefined, NOW, hasher),
    ).resolves.toBeUndefined();
    await expect(
      verifyAccountPassword(
        googleOnly as never,
        session(NOW - 16 * 60_000),
        undefined,
        NOW,
        hasher,
      ),
    ).rejects.toMatchObject({ details: { reason: 'reauth_required' } });
  });
});
