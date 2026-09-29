import type { PrismaClient } from '@prisma/client';
import { AuditAction, type AuditRecord } from '../audit-sink';
import { ConflictError, NotFoundError } from '../errors';

// Phase 18 §5.11 — delete my account.
//   - Sole owner of an organisation that has other members: blocked until ownership moves.
//   - Sole member of an organisation: the organisation is deleted with it (Stripe subscription
//     cancelled now, the existing purgeOrganisation flow: 30-day grace, then hard delete).
//   - Otherwise: the membership ends now.
// The user is soft-deleted at once (no sign-in, sessions revoked) and removed at the end of the
// grace by the daily job (purgeDeletedUsers). Audit rows (ids only) and email suppressions stay.

export const ACCOUNT_DELETION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type Db = Pick<PrismaClient, 'member' | 'organization' | 'user' | 'session'>;

export interface DeletionPlan {
  /** Organisations the user owns alone while others are members: transfer ownership first. */
  blockedBy: Array<{ organisationId: string; name: string }>;
  /** Organisations deleted with the account (the user is their only member). */
  deleteOrganisations: string[];
  /** Organisations the user simply leaves. */
  leaveOrganisations: string[];
}

export async function planAccountDeletion(db: Db, userId: string): Promise<DeletionPlan> {
  const memberships = await db.member.findMany({
    where: { userId, organization: { deletedAt: null } },
    select: {
      organizationId: true,
      role: true,
      organization: { select: { name: true, members: { select: { userId: true, role: true } } } },
    },
  });
  const plan: DeletionPlan = { blockedBy: [], deleteOrganisations: [], leaveOrganisations: [] };
  for (const m of memberships) {
    const others = m.organization.members.filter((x) => x.userId !== userId);
    if (others.length === 0) {
      plan.deleteOrganisations.push(m.organizationId);
    } else if (m.role === 'owner' && !others.some((x) => x.role === 'owner')) {
      plan.blockedBy.push({ organisationId: m.organizationId, name: m.organization.name });
    } else {
      plan.leaveOrganisations.push(m.organizationId);
    }
  }
  return plan;
}

export interface AccountDeletionDeps {
  db: Db;
  now: () => number;
  /** The existing organisation purge (services/organisation-purge.ts). */
  purgeOrganisation: (organisationId: string) => Promise<unknown>;
  /** Cancel the organisation's Stripe subscription now (Track C); absent = no billing. */
  cancelBilling?: (organisationId: string) => Promise<void>;
  audit: (record: AuditRecord) => Promise<void>;
  /** Tell the user (accountDeletionScheduled email); failures are logged by the mailer. */
  notify?: (graceUntil: Date) => Promise<void>;
}

export interface DeletionResult {
  graceUntil: string;
  deletedOrganisations: string[];
  leftOrganisations: string[];
}

export async function deleteAccount(
  deps: AccountDeletionDeps,
  userId: string,
): Promise<DeletionResult> {
  const user = await deps.db.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw new NotFoundError('Account not found');
  const plan = await planAccountDeletion(deps.db, userId);
  if (plan.blockedBy.length > 0) {
    throw new ConflictError(
      'Transfer ownership of your organisations before deleting your account',
      {
        reason: 'sole_owner',
        organisations: plan.blockedBy,
      },
    );
  }
  const now = new Date(deps.now());
  for (const organisationId of plan.deleteOrganisations) {
    await deps.cancelBilling?.(organisationId);
    await deps.purgeOrganisation(organisationId);
    await deps.db.organization.update({ where: { id: organisationId }, data: { deletedAt: now } });
    await deps.audit({
      actorUserId: userId,
      organisationId,
      action: AuditAction.OrgDeleted,
      resource: { type: 'organisation', id: organisationId },
      metadata: { reason: 'account_deleted' },
    });
  }
  for (const organisationId of plan.leaveOrganisations) {
    await deps.db.member.deleteMany({ where: { organizationId: organisationId, userId } });
    await deps.audit({
      actorUserId: userId,
      organisationId,
      action: AuditAction.MemberRemoved,
      resource: { type: 'user', id: userId },
      metadata: { reason: 'account_deleted' },
    });
  }
  await deps.db.user.update({ where: { id: userId }, data: { deletedAt: now } });
  await deps.db.session.deleteMany({ where: { userId } });
  const graceUntil = new Date(now.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
  await deps.audit({
    actorUserId: userId,
    action: AuditAction.AccountDeletionScheduled,
    resource: { type: 'user', id: userId },
    metadata: { graceUntil: graceUntil.toISOString() },
  });
  await deps.notify?.(graceUntil);
  return {
    graceUntil: graceUntil.toISOString(),
    deletedOrganisations: plan.deleteOrganisations,
    leftOrganisations: plan.leaveOrganisations,
  };
}

/**
 * Daily: remove users whose deletion grace has passed. users → sessions, auth_accounts,
 * two_factors, members and sent invitations go by FK cascade. Returns how many users.
 */
export async function purgeDeletedUsers(
  db: Pick<PrismaClient, 'user'>,
  now: number,
  graceDays: number = ACCOUNT_DELETION_GRACE_DAYS,
): Promise<number> {
  const cutoff = new Date(now - graceDays * DAY_MS);
  const { count } = await db.user.deleteMany({ where: { deletedAt: { lt: cutoff } } });
  return count;
}
