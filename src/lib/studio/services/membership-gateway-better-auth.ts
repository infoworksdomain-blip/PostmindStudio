import { APIError } from 'better-auth/api';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from '../../errors';
import type { MembershipGateway } from './membership-gateway';

// Phase 18 §2.4 — MembershipGateway over Better Auth's organization plugin (Track A's instance,
// src/lib/auth/server.ts), called server-side with the caller's request headers so the plugin's
// own checks run as the signed-in member: role permissions, last-owner protection, the seat limit
// on acceptance (membershipLimit from entitlements), the invite email, and Track A's audit and
// identity-cache hooks. Endpoint bodies checked against the pinned better-auth@1.7.6
// (dist/plugins/organization/routes/crud-invites.mjs and crud-members.mjs, 2026-09-29):
//   createInvitation {email, role, organizationId?, resend?}   cancelInvitation {invitationId}
//   updateMemberRole {memberId, role, organizationId?}         removeMember {memberIdOrEmail, organizationId?}

/** The subset of `auth.api` the gateway calls (a structural type, so tests can pass a fake). */
export interface OrganisationAuthApi {
  createInvitation(args: {
    headers: Headers;
    body: { email: string; role: string; organizationId: string; resend?: boolean };
  }): Promise<{ id: string } | null | undefined>;
  cancelInvitation(args: { headers: Headers; body: { invitationId: string } }): Promise<unknown>;
  updateMemberRole(args: {
    headers: Headers;
    body: { memberId: string; role: string; organizationId: string };
  }): Promise<unknown>;
  removeMember(args: {
    headers: Headers;
    body: { memberIdOrEmail: string; organizationId: string };
  }): Promise<unknown>;
}

/** Better Auth errors → Studio errors (the UI keys its messages on code / details.reason). */
export function mapOrganisationError(err: unknown): never {
  if (err instanceof APIError) {
    const code = (err.body as { code?: string } | undefined)?.code ?? '';
    const message = err.message || code || 'Request refused';
    if (code === 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED')
      throw new QuotaExceededError(message, { reason: 'seat_limit' });
    if (code === 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER')
      throw new ConflictError(message, { reason: 'last_owner' });
    if (code === 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION')
      throw new ConflictError(message, { reason: 'already_member' });
    if (err.statusCode === 404 || /NOT_FOUND/.test(code))
      throw new NotFoundError(message, { code });
    if (err.statusCode === 403 || err.statusCode === 401)
      throw new ForbiddenError(message, { code });
    if (err.statusCode === 400) throw new ValidationError(message, { code });
  }
  throw err;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return mapOrganisationError(err);
  }
}

export function createBetterAuthMembershipGateway(
  api: () => Promise<OrganisationAuthApi>,
): MembershipGateway {
  return {
    async createInvitation(headers, input) {
      const res = await call(async () =>
        (await api()).createInvitation({
          headers,
          body: {
            email: input.email,
            role: input.role,
            organizationId: input.organisationId,
            ...(input.resend && { resend: true }),
          },
        }),
      );
      if (!res?.id) throw new ValidationError('The invitation was not created');
      return { id: res.id };
    },
    async cancelInvitation(headers, input) {
      await call(async () =>
        (await api()).cancelInvitation({ headers, body: { invitationId: input.invitationId } }),
      );
    },
    async updateMemberRole(headers, input) {
      await call(async () =>
        (await api()).updateMemberRole({
          headers,
          body: {
            memberId: input.memberId,
            role: input.role,
            organizationId: input.organisationId,
          },
        }),
      );
    },
    async removeMember(headers, input) {
      await call(async () =>
        (await api()).removeMember({
          headers,
          body: { memberIdOrEmail: input.memberId, organizationId: input.organisationId },
        }),
      );
    },
  };
}

/** The production gateway: Track A's process-wide Better Auth instance. */
export function betterAuthMembershipGateway(): MembershipGateway {
  return createBetterAuthMembershipGateway(async () => {
    const { getAuth } = await import('../../auth/server');
    return (await getAuth()).api as unknown as OrganisationAuthApi;
  });
}
