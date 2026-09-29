import { NotImplementedError } from '../../errors';
import { studioModes } from '../../mode';
import { betterAuthMembershipGateway } from './membership-gateway-better-auth';

// Phase 18 §2.4 — every membership and invitation WRITE goes through Better Auth's organization
// plugin (server API, with the caller's request headers) so its rules run once, in one place:
// the seat limit (membershipLimit from entitlements), the verified-email match on acceptance,
// last-owner protection, the invite email, the audit entries and identity cache invalidation.
// Studio's routes (api/studio/members/*, org/transfer-ownership) check their own capability and
// role rules first (members.ts), then call this gateway.
//
// Standalone mode uses the Better Auth implementation (membership-gateway-better-auth.ts, over
// Track A's src/lib/auth/server.ts). Core mode has no local membership writes (Core owns members),
// so writes answer 501 instead of writing the tables behind anyone's back.

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

const CORE_MODE = 'Members are managed in PostMind Core (STUDIO_MODE=core)';

export const coreModeMembershipGateway: MembershipGateway = {
  async createInvitation() {
    throw new NotImplementedError(CORE_MODE);
  },
  async cancelInvitation() {
    throw new NotImplementedError(CORE_MODE);
  },
  async updateMemberRole() {
    throw new NotImplementedError(CORE_MODE);
  },
  async removeMember() {
    throw new NotImplementedError(CORE_MODE);
  },
};

let installed: MembershipGateway | undefined;

export function getMembershipGateway(
  env: Record<string, string | undefined> = process.env,
): MembershipGateway {
  if (installed) return installed;
  return studioModes(env).identity === 'standalone'
    ? betterAuthMembershipGateway()
    : coreModeMembershipGateway;
}

/** Install the gateway (Better Auth at start-up; a fake in tests). Pass undefined to reset. */
export function setMembershipGateway(next: MembershipGateway | undefined): void {
  installed = next;
}
