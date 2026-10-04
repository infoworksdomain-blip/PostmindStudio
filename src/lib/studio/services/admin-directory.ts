import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError } from '../../errors';
import { parseOverrides, resolveStoredEntitlements } from '../billing/entitlements';
import { utcMonthRange } from '../cost/caps';

// Phase 18 §3 admin tabs (PostMind staff, standalone mode): Organisations (search, plan, status,
// members, cost this month; detail with members and subscription), Users (search by email,
// verified, 2FA, role, sessions, ban / unban, revoke sessions, reset 2FA — every action audited
// by the route) and Subscriptions (read-only, status filters, past-due list). Plan and status come
// from Track C's tables (org_entitlements, subscriptions); amounts (MRR) live in Stripe and are
// not shown here.

const PAGE = 50;

export const searchQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const subscriptionsQuery = z
  .object({
    status: z
      .enum(['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused'])
      .optional(),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const banInput = z
  .object({ banned: z.boolean(), reason: z.string().trim().min(3).max(500) })
  .strict();

export const reasonInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

async function monthSpend(
  db: PrismaClient,
  organisationIds: string[],
  now: number,
): Promise<Map<string, number>> {
  if (organisationIds.length === 0) return new Map();
  const month = utcMonthRange(new Date(now));
  const rows = await db.providerUsage.groupBy({
    by: ['organisationId'],
    where: { organisationId: { in: organisationIds }, day: { gte: month.start, lt: month.end } },
    _sum: { costPence: true },
  });
  return new Map(rows.map((r) => [r.organisationId, r._sum.costPence ?? 0]));
}

export async function searchOrganisations(
  db: PrismaClient,
  query: z.infer<typeof searchQuery>,
  now: number,
) {
  const q = query.q;
  const where: Prisma.OrganizationWhereInput = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { slug: { contains: q.toLowerCase() } },
          { id: q },
        ],
      }
    : {};
  const [orgs, total] = await Promise.all([
    db.organization.findMany({
      where,
      // id breaks ties so paging never repeats or skips organisations created together.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: query.offset,
      take: PAGE,
      include: { _count: { select: { members: true } } },
    }),
    db.organization.count({ where }),
  ]);
  const ids = orgs.map((o) => o.id);
  const [entitlements, subscriptions, spend] = await Promise.all([
    db.orgEntitlement.findMany({ where: { organisationId: { in: ids } } }),
    db.subscription.findMany({
      where: { organisationId: { in: ids } },
      orderBy: { updatedAt: 'desc' },
    }),
    monthSpend(db, ids, now),
  ]);
  const ent = new Map(entitlements.map((e) => [e.organisationId, e]));
  const sub = new Map<string, (typeof subscriptions)[number]>();
  for (const s of subscriptions) if (!sub.has(s.organisationId)) sub.set(s.organisationId, s);
  return {
    total,
    offset: query.offset,
    pageSize: PAGE,
    data: orgs.map((o) => {
      const plan = planSummary(ent.get(o.id), new Date(now));
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        country: o.country,
        createdAt: o.createdAt.toISOString(),
        deletedAt: o.deletedAt?.toISOString() ?? null,
        members: o._count.members,
        ...plan,
        subscriptionStatus: sub.get(o.id)?.status ?? null,
        costThisMonthPence: spend.get(o.id) ?? 0,
      };
    }),
  };
}

type EntitlementRow = Awaited<ReturnType<PrismaClient['orgEntitlement']['findMany']>>[number];

/**
 * 20.27: the plan as it applies now (admin override expiry and the grace clock resolved, as the
 * EntitlementsReader does), and the trial's state: running (its caps apply), overridden (a staff
 * override is active), ended (staff ended it) or null (no trial, or Stripe no longer trialing).
 * 21.5: and the channel plan in force (channels, interval, set by staff or Stripe), or null.
 */
export function planSummary(row: EntitlementRow | undefined, now: Date) {
  if (!row) return { tier: null, access: null, source: null, trial: null, channelPlan: null };
  const effective = resolveStoredEntitlements(row, now);
  const overrides = parseOverrides(row.overrides);
  const trialing = overrides.derived?.source === 'trial';
  const trial = overrides.trial;
  const state = !trial
    ? null
    : trial.endedAt
      ? ('ended' as const)
      : effective.trial
        ? ('running' as const)
        : trialing
          ? ('overridden' as const)
          : null;
  return {
    tier: effective.tier,
    access: effective.access,
    source: effective.source,
    trial: state && trial ? { state, endsAt: trial.endsAt } : null,
    channelPlan: effective.channelPlan
      ? {
          channels: effective.channelPlan.channels,
          interval: effective.channelPlan.interval,
          source: effective.channelPlan.source,
        }
      : null,
  };
}

export async function organisationDetail(db: PrismaClient, organisationId: string, now: number) {
  const org = await db.organization.findUnique({ where: { id: organisationId } });
  if (!org) throw new NotFoundError('Organisation not found');
  const [members, invitations, entitlement, subscriptions, businesses, spend] = await Promise.all([
    db.member.findMany({
      where: { organizationId: org.id },
      include: { user: { select: { email: true, name: true, twoFactorEnabled: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.invitation.count({ where: { organizationId: org.id, status: 'pending' } }),
    db.orgEntitlement.findUnique({ where: { organisationId: org.id } }),
    db.subscription.findMany({
      where: { organisationId: org.id },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    db.business.count({ where: { organisationId: org.id, deletedAt: null } }),
    monthSpend(db, [org.id], now),
  ]);
  const plan = planSummary(entitlement ?? undefined, new Date(now));
  return {
    organisation: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      country: org.country,
      defaultLocale: org.defaultLocale,
      createdAt: org.createdAt.toISOString(),
      deletedAt: org.deletedAt?.toISOString() ?? null,
    },
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      twoFactorEnabled: m.user.twoFactorEnabled === true,
      joinedAt: m.createdAt.toISOString(),
    })),
    pendingInvitations: invitations,
    businesses,
    entitlement: entitlement && {
      // Resolved at read time (override expiry, grace clock), like the list.
      tier: plan.tier ?? entitlement.tier,
      access: plan.access ?? entitlement.access,
      source: plan.source ?? entitlement.source,
      trial: plan.trial,
      channelPlan: plan.channelPlan,
      graceUntil: entitlement.graceUntil?.toISOString() ?? null,
      trialStartedAt: entitlement.trialStartedAt?.toISOString() ?? null,
      everPaidAt: entitlement.everPaidAt?.toISOString() ?? null,
      reason: entitlement.reason,
      updatedAt: entitlement.updatedAt.toISOString(),
    },
    subscriptions: subscriptions.map(subscriptionView),
    costThisMonthPence: spend.get(org.id) ?? 0,
  };
}

type SubscriptionRow = Awaited<ReturnType<PrismaClient['subscription']['findMany']>>[number];

function subscriptionView(s: SubscriptionRow) {
  return {
    id: s.id,
    organisationId: s.organisationId,
    status: s.status,
    lookupKey: s.lookupKey,
    interval: s.interval,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    trialEnd: s.trialEnd?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function searchUsers(db: PrismaClient, query: z.infer<typeof searchQuery>) {
  const q = query.q?.toLowerCase();
  const where: Prisma.UserWhereInput = q
    ? {
        OR: [{ email: { contains: q } }, { id: q }, { name: { contains: q, mode: 'insensitive' } }],
      }
    : {};
  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.offset,
      take: PAGE,
      include: { _count: { select: { sessions: true, members: true } } },
    }),
    db.user.count({ where }),
  ]);
  return { total, data: users.map(userView) };
}

type UserRow = Awaited<ReturnType<typeof findUserWithCounts>>;

function findUserWithCounts(db: PrismaClient, id: string) {
  return db.user.findUnique({
    where: { id },
    include: { _count: { select: { sessions: true, members: true } } },
  });
}

function userView(u: NonNullable<UserRow>) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    twoFactorEnabled: u.twoFactorEnabled === true,
    role: u.role ?? 'user',
    banned: u.banned === true,
    banReason: u.banReason,
    createdAt: u.createdAt.toISOString(),
    deletedAt: u.deletedAt?.toISOString() ?? null,
    sessions: u._count.sessions,
    organisations: u._count.members,
  };
}

export async function userDetail(db: PrismaClient, userId: string) {
  const user = await findUserWithCounts(db, userId);
  if (!user) throw new NotFoundError('User not found');
  const memberships = await db.member.findMany({
    where: { userId },
    include: { organization: { select: { id: true, name: true } } },
  });
  return {
    user: userView(user),
    memberships: memberships.map((m) => ({
      organisationId: m.organization.id,
      organisationName: m.organization.name,
      role: m.role,
    })),
  };
}

export async function findUserForAction(db: PrismaClient, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, banned: true, deletedAt: true },
  });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

/** Ban or unban; a ban also revokes every session so it takes effect at once. */
export async function setUserBan(
  db: PrismaClient,
  userId: string,
  input: z.infer<typeof banInput>,
): Promise<{ sessionsRevoked: number }> {
  await findUserForAction(db, userId);
  return db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: input.banned
        ? { banned: true, banReason: input.reason, banExpires: null }
        : { banned: false, banReason: null, banExpires: null },
    });
    if (!input.banned) return { sessionsRevoked: 0 };
    const { count } = await tx.session.deleteMany({ where: { userId } });
    return { sessionsRevoked: count };
  });
}

export async function revokeUserSessions(db: PrismaClient, userId: string): Promise<number> {
  await findUserForAction(db, userId);
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}

/** Lost authenticator: remove the TOTP secret and backup codes; the user re-enrols. */
export async function resetUserTwoFactor(db: PrismaClient, userId: string): Promise<void> {
  await findUserForAction(db, userId);
  await db.$transaction([
    db.twoFactor.deleteMany({ where: { userId } }),
    db.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } }),
    // Sessions that passed the 2FA step with the old factor are ended too.
    db.session.deleteMany({ where: { userId } }),
  ]);
}

export async function listSubscriptions(
  db: PrismaClient,
  query: z.infer<typeof subscriptionsQuery>,
) {
  const where: Prisma.SubscriptionWhereInput = query.status ? { status: query.status } : {};
  const [rows, total, counts] = await Promise.all([
    db.subscription.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: query.offset,
      take: PAGE,
    }),
    db.subscription.count({ where }),
    db.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const orgs = await db.organization.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.organisationId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  const pastDue = await db.orgEntitlement.findMany({
    where: { organisationId: { in: rows.map((r) => r.organisationId) } },
    select: { organisationId: true, graceUntil: true },
  });
  const grace = new Map(pastDue.map((p) => [p.organisationId, p.graceUntil]));
  return {
    total,
    byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    data: rows.map((r) => ({
      ...subscriptionView(r),
      organisationName: names.get(r.organisationId) ?? null,
      graceUntil: grace.get(r.organisationId)?.toISOString() ?? null,
    })),
  };
}
