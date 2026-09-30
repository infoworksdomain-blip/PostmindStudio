import { describe, expect, it, vi } from 'vitest';
import { buildAuthOptions, flushAuthEmails, type AuthConfigDeps } from './config';

// scripts/auth/create-superadmin.ts disconnected Prisma while the set-password email was still
// being queued in the background, so no email was sent (first server, 2026-09-30).
// flushAuthEmails() must wait for every auth email started so far.

function deps(sendAuthEmail: AuthConfigDeps['mailer']['sendAuthEmail']): AuthConfigDeps {
  return {
    db: {} as AuthConfigDeps['db'],
    secret: 'x'.repeat(32),
    baseURL: 'https://studio.example.test',
    mailer: { sendAuthEmail } as AuthConfigDeps['mailer'],
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as AuthConfigDeps['logger'],
    rateLimitStore: {} as AuthConfigDeps['rateLimitStore'],
    entitlements: {} as AuthConfigDeps['entitlements'],
    audit: async () => undefined,
    signupsEnabled: true,
    breachCheck: false,
    trustedProxies: [],
    impersonationEnabled: false,
    secureCookies: true,
  };
}

const user = { id: 'u1', email: 'owner@example.test', name: 'Owner', emailVerified: false };

describe('flushAuthEmails', () => {
  it('waits for a reset-password email queued in the background', async () => {
    let release!: () => void;
    const queued = vi.fn(
      () => new Promise<{ id: string }>((resolve) => (release = () => resolve({ id: 'e1' }))),
    );
    const options = buildAuthOptions(deps(queued as never));
    await options.emailAndPassword!.sendResetPassword!({
      user: user as never,
      url: 'https://studio.example.test/reset?t=1',
      token: 'tok',
    });
    expect(queued).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flush = flushAuthEmails().then(() => (flushed = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it('a failed send is logged, never thrown, and still lets the flush finish', async () => {
    const failing = vi.fn(async () => {
      throw new Error('outbox down');
    });
    const d = deps(failing as never);
    const options = buildAuthOptions(d);
    await options.emailAndPassword!.sendResetPassword!({
      user: user as never,
      url: 'https://studio.example.test/reset?t=2',
      token: 'tok2',
    });
    await expect(flushAuthEmails()).resolves.toBeUndefined();
    expect(d.logger.error).toHaveBeenCalled();
  });
});
