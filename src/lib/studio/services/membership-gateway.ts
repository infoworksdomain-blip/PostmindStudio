import { NotImplementedError } from '../../errors';

// Phase 18 §2.4 — every membership and invitation WRITE goes through Better Auth's organization
// plugin (server API, with the caller's request headers) so its rules run once, in one place:
// the seat limit (membershipLimit from entitlements), the verified-email match on acceptance,
// last-owner protection, the invite email, the audit entries and identity cache invalidation.
// Studio's routes (api/studio/members/*, org/transfer-ownership) check their own capability and
// role rules first (members.ts), then call this gateway.
//
// The Better Auth implementation (members-gateway-better-auth.ts) lands with Track A milestone
// A1 (src/lib/auth/server.ts). Until it is installed, writes answer 501 instead of writing the
// tables behind Better Auth's back.

export const ORG_ROLES = ['owner', 'admin', 'publisher', 'creator', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export interface MembershipGateway {
  createInvitation(
    headers: Headers,
    input: { organisationId: string; email: string; role: OrgRole; resend?: boolean },
  ): Promise<{ id: string }>;
  cancelInvitation(headers: Headers, input: { invitationId: string }): Promise<void>;
  updateMemberRole(
    headers: Headers,
    input: { organisationId: string; memberId: string; role: OrgRole },
  ): Promise<void>;
  removeMember(
    headers: Headers,
    input: { organisationId: string; memberId: string },
  ): Promise<void>;
}

const pending: MembershipGateway = {
  async createInvitation() {
    throw new NotImplementedError('Invitations need Better Auth (Phase 18 milestone A1)');
  },
  async cancelInvitation() {
    throw new NotImplementedError('Invitations need Better Auth (Phase 18 milestone A1)');
  },
  async updateMemberRole() {
    throw new NotImplementedError('Role changes need Better Auth (Phase 18 milestone A1)');
  },
  async removeMember() {
    throw new NotImplementedError('Removing members needs Better Auth (Phase 18 milestone A1)');
  },
};

let installed: MembershipGateway | undefined;

export function getMembershipGateway(): MembershipGateway {
  return installed ?? pending;
}

/** Install the gateway (Better Auth at start-up; a fake in tests). Pass undefined to reset. */
export function setMembershipGateway(next: MembershipGateway | undefined): void {
  installed = next;
}
