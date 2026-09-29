import type { PrismaClient } from '@prisma/client';
import { ForbiddenError } from '../errors';
import { SESSION_FRESH_S } from './config';
import { createArgon2Hasher, type PasswordHasher } from './password';
import type { SignedInSession } from './session-route';

// Phase 18 §5.11 — re-authentication before a destructive action. An account with a password
// must give it; an account without one (Google only) must have signed in within the last
// SESSION_FRESH_S (15 minutes).

export async function verifyAccountPassword(
  db: Pick<PrismaClient, 'account'>,
  session: SignedInSession,
  password: string | undefined,
  now: number,
  hasher: PasswordHasher = createArgon2Hasher(),
): Promise<void> {
  const credential = await db.account.findFirst({
    where: { userId: session.user.id, providerId: 'credential' },
    select: { password: true },
  });
  if (credential?.password) {
    const ok =
      typeof password === 'string' &&
      password.length > 0 &&
      (await hasher.verify({ hash: credential.password, password }));
    if (!ok) throw new ForbiddenError('Password is incorrect', { reason: 'reauth_failed' });
    return;
  }
  const createdAt = session.session.createdAt ? new Date(session.session.createdAt).getTime() : 0;
  if (!(now - createdAt <= SESSION_FRESH_S * 1000)) {
    throw new ForbiddenError('Sign in again to confirm', { reason: 'reauth_required' });
  }
}

/**
 * For routes built on withStudioRoute (tenant, not a SignedInSession), e.g. organisation deletion
 * and ownership transfer: reads the Better Auth session from the request and applies the same
 * rule. Throws UnauthorizedError without a session, ForbiddenError (reauth_failed /
 * reauth_required) otherwise.
 */
export async function reauthenticateRequest(
  req: Pick<Request, 'headers'>,
  password: string | undefined,
  now: number = Date.now(),
): Promise<void> {
  const [{ betterAuthApi }, { prisma }, { UnauthorizedError }] = await Promise.all([
    import('./server-api'),
    import('../prisma'),
    import('../errors'),
  ]);
  const session = await (await betterAuthApi()).getSession(new Headers(req.headers));
  if (!session) throw new UnauthorizedError('Sign in to continue');
  await verifyAccountPassword(prisma, session, password, now);
}
