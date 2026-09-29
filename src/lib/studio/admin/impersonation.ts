import { ForbiddenError, NotFoundError, NotImplementedError } from '../../errors';
import type { TenantContext } from '../../tenant';

// Phase 18 §2.5 — impersonation is OFF by default (STUDIO_IMPERSONATION_ENABLED=false). When on:
// superadmin only (studio:admin:impersonate, which staff hold only with 2FA), a reason is
// required, staff can never impersonate other staff, sessions last 30 minutes with a banner, and
// they are READ-ONLY unless STUDIO_IMPERSONATION_WRITE=true. Every start is audited.
//
// This module holds the policy. Creating the impersonation session is Better Auth's admin plugin
// (impersonateUser), installed with setImpersonationStarter() by auth/server.ts when the flag is on
// (auth/impersonation-starter.ts); otherwise (core mode, flag off) a start answers 501.

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined) => v?.trim().toLowerCase() === 'true';

export function impersonationEnabled(env: Env = process.env): boolean {
  return truthy(env.STUDIO_IMPERSONATION_ENABLED);
}

export function impersonationWriteAllowed(env: Env = process.env): boolean {
  return truthy(env.STUDIO_IMPERSONATION_WRITE);
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defence in depth for withStudioRoute (the standalone IdentityProvider enforces the same rule):
 * a request made while impersonating may only read, unless impersonated writes are switched on.
 */
export function assertImpersonationAllowsWrite(
  tenant: Pick<TenantContext, 'impersonatorUserId'>,
  method: string,
  env: Env = process.env,
): void {
  if (!tenant.impersonatorUserId || READ_METHODS.has(method.toUpperCase())) return;
  if (impersonationWriteAllowed(env)) return;
  throw new ForbiddenError('Impersonation sessions are read-only', {
    reason: 'impersonation_read_only',
  });
}

export interface ImpersonationTarget {
  id: string;
  role: string | null;
  banned: boolean | null;
  deletedAt: Date | null;
}

/** The policy checks, in order; throws the first that fails. */
export function assertCanImpersonate(
  actor: Pick<TenantContext, 'userId' | 'impersonatorUserId'>,
  target: ImpersonationTarget | null,
  env: Env = process.env,
): asserts target is ImpersonationTarget {
  if (!impersonationEnabled(env))
    throw new ForbiddenError('Impersonation is switched off', { reason: 'impersonation_disabled' });
  if (actor.impersonatorUserId)
    throw new ForbiddenError('Already impersonating', { reason: 'impersonation_nested' });
  if (!target || target.deletedAt) throw new NotFoundError('User not found');
  if (target.id === actor.userId)
    throw new ForbiddenError('You cannot impersonate yourself', { reason: 'impersonation_self' });
  if (target.role === 'staff' || target.role === 'superadmin')
    throw new ForbiddenError('Staff cannot be impersonated', { reason: 'impersonation_staff' });
  if (target.banned)
    throw new ForbiddenError('Banned users cannot be impersonated', {
      reason: 'impersonation_banned',
    });
}

export interface ImpersonationStarter {
  /**
   * Create the impersonation session for the caller's request; returns where to go next and the
   * session's Set-Cookie headers (the route forwards them).
   */
  start(
    headers: Headers,
    input: { userId: string },
  ): Promise<{ redirectTo: string; setCookies?: string[] }>;
}

const pendingStarter: ImpersonationStarter = {
  async start() {
    throw new NotImplementedError(
      'Impersonation sessions need Better Auth (Phase 18 milestone A3)',
    );
  },
};

let starter: ImpersonationStarter | undefined;

export function getImpersonationStarter(): ImpersonationStarter {
  return starter ?? pendingStarter;
}

export function setImpersonationStarter(next: ImpersonationStarter | undefined): void {
  starter = next;
}
