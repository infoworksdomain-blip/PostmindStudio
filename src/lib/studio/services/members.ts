import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, QuotaExceededError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { getMembershipGateway, ORG_ROLES, type OrgRole } from './membership-gateway';

// Phase 18 §2.4 — /settings/members: the members table, pending invitations and the seat meter,
// plus Studio's own role rules, checked BEFORE the Better Auth gateway runs the write:
//   - admins manage everyone except owners; only an owner may grant, change or remove an owner;
//   - the last owner can never be demoted or removed (transfer ownership first);
//   - ownership is granted only by transfer (org-settings.ts), never by invite.
// Better Auth enforces last-owner protection and the seat limit again (defence in depth).

export const INVITE_ROLES = ['admin', 'publisher', 'creator', 'viewer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const inviteInput = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(INVITE_ROLES),
  })
  .strict();

export const changeRoleInput = z.object({ role: z.enum(ORG_ROLES) }).strict();

export interface MemberView {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
  twoFactorEnabled: boolean;
  isYou: boolean;
}

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
  expiresAt: string;
  inviterId: string;
}

export interface SeatUsage {
  used: number;
  /** null = unlimited. */
  limit: number | null;
}

/** The caller's role in their active organisation (standalone sets tenant.role). */
export function actorRole(tenant: TenantContext): string | undefined {
  return (
    tenant.role ??
    tenant.memberships.find((m) => m.organisationId === tenant.organisationId)?.role ??
    undefined
  );
}

export async function listMembers(db: PrismaClient, tenant: TenantContext): Promise<MemberView[]> {
  const rows = await db.member.findMany({
    where: { organizationId: tenant.organisationId, user: { deletedAt: null } },
    include: { user: { select: { name: true, email: true, twoFactorEnabled: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
    twoFactorEnabled: m.user.twoFactorEnabled === true,
    isYou: m.userId === tenant.userId,
  }));
}

export async function listInvitations(
  db: PrismaClient,
  organisationId: string,
  now: number,
): Promise<InvitationView[]> {
  const rows = await db.invitation.findMany({
    where: { organizationId: organisationId, status: 'pending', expiresAt: { gt: new Date(now) } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role ?? 'viewer',
    invitedAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    inviterId: i.inviterId,
  }));
}

export async function seatUsage(
  entitlements: EntitlementsReader | undefined,
  organisationId: string,
  members: number,
  pendingInvites: number,
): Promise<SeatUsage> {
  const limit = entitlements
    ? (await entitlements.forOrganisation(organisationId)).limits.seats
    : null;
  return { used: members + pendingInvites, limit };
}

async function findMember(db: PrismaClient, organisationId: string, memberId: string) {
  const member = await db.member.findFirst({
    where: { id: memberId, organizationId: organisationId },
  });
  if (!member) throw new NotFoundError('Member not found');
  return member;
}

async function ownerCount(db: PrismaClient, organisationId: string): Promise<number> {
  return db.member.count({ where: { organizationId: organisationId, role: 'owner' } });
}

function ownerOnly(message: string): never {
  throw new ForbiddenError(message, { reason: 'owner_only' });
}

function lastOwner(): never {
  throw new ConflictError('The last owner cannot be removed or demoted; transfer ownership first', {
    reason: 'last_owner',
  });
}

/** Studio's rules for a role change; throws when the change is not allowed. */
export async function assertCanChangeRole(
  db: PrismaClient,
  tenant: TenantContext,
  memberId: string,
  role: OrgRole,
): Promise<void> {
  const target = await findMember(db, tenant.organisationId, memberId);
  const isOwner = actorRole(tenant) === 'owner';
  if ((target.role === 'owner' || role === 'owner') && !isOwner)
    ownerOnly('Only an owner can change an owner or grant ownership');
  if (target.role === 'owner' && role !== 'owner') {
    if ((await ownerCount(db, tenant.organisationId)) <= 1) lastOwner();
  }
}

/** Studio's rules for removing a member (or leaving); throws when not allowed. */
export async function assertCanRemove(
  db: PrismaClient,
  tenant: TenantContext,
  memberId: string,
): Promise<void> {
  const target = await findMember(db, tenant.organisationId, memberId);
  if (target.role === 'owner') {
    if (actorRole(tenant) !== 'owner') ownerOnly('Only an owner can remove an owner');
    if ((await ownerCount(db, tenant.organisationId)) <= 1) lastOwner();
  }
}

export async function assertInvitationInOrg(
  db: PrismaClient,
  organisationId: string,
  invitationId: string,
) {
  const invitation = await db.invitation.findFirst({
    where: { id: invitationId, organizationId: organisationId, status: 'pending' },
  });
  if (!invitation) throw new NotFoundError('Invitation not found');
  return invitation;
}

/**
 * Better Auth checks the plan's seat limit when an invitation is ACCEPTED (membershipLimit in
 * pinned better-auth@1.7.6 crud-invites.mjs); Studio also refuses to SEND one when members plus
 * pending invitations already fill the plan, so nobody is invited to a seat that does not exist.
 */
export async function assertSeatAvailable(
  db: PrismaClient,
  entitlements: EntitlementsReader | undefined,
  organisationId: string,
  now: number,
): Promise<void> {
  if (!entitlements) return;
  const [members, pending] = await Promise.all([
    db.member.count({ where: { organizationId: organisationId } }),
    db.invitation.count({
      where: {
        organizationId: organisationId,
        status: 'pending',
        expiresAt: { gt: new Date(now) },
      },
    }),
  ]);
  const { used, limit } = await seatUsage(entitlements, organisationId, members, pending);
  if (limit !== null && used >= limit)
    throw new QuotaExceededError('Every seat on the plan is in use', {
      reason: 'seat_limit',
      used,
      limit,
    });
}

export async function inviteMember(
  db: PrismaClient,
  tenant: TenantContext,
  headers: Headers,
  input: z.infer<typeof inviteInput>,
  seats?: { entitlements?: EntitlementsReader; now: number },
) {
  const already = await db.member.findFirst({
    where: { organizationId: tenant.organisationId, user: { email: input.email } },
    select: { id: true },
  });
  if (already)
    throw new ConflictError('This person is already a member', { reason: 'already_member' });
  if (seats) await assertSeatAvailable(db, seats.entitlements, tenant.organisationId, seats.now);
  return getMembershipGateway().createInvitation(headers, {
    organisationId: tenant.organisationId,
    email: input.email,
    role: input.role,
  });
}

export async function resendInvitation(
  db: PrismaClient,
  tenant: TenantContext,
  headers: Headers,
  invitationId: string,
) {
  const invitation = await assertInvitationInOrg(db, tenant.organisationId, invitationId);
  const role = (INVITE_ROLES as readonly string[]).includes(invitation.role ?? '')
    ? (invitation.role as InviteRole)
    : 'viewer';
  return getMembershipGateway().createInvitation(headers, {
    organisationId: tenant.organisationId,
    email: invitation.email,
    role,
    resend: true,
  });
}
