import type { PrismaClient } from '@prisma/client';
import { studioModes, type StudioModes } from '../../mode';
import type { TenantContext } from '../../tenant';
import { ConfigurationError } from '../../errors';
import { ENDED_STATUSES, parseOverrides } from '../billing/entitlements';
import type { Entitlements, EntitlementsReader } from '../billing/entitlements-reader';
import { cancelledRetentionDays } from '../billing/retention';
import { actorRole } from './members';

// Phase 18 §3 cross-cutting UI — what the AppShell needs on every page: who is signed in (user
// menu), the active organisation and the others the user belongs to (switcher), the account
// state for the banners (trial, past due, read-only, no plan) and whether a superadmin is
// impersonating. Core mode has no local users or organisations, so those fields fall back to the
// ids in the tenant context.

export interface MeOrganisation {
  id: string;
  name: string;
  role: string | null;
}

export type AccountBanner =
  | { kind: 'trial'; endsAt: string }
  | { kind: 'past_due'; graceUntil: string | null }
  | { kind: 'read_only' }
  /** Phase 19.5: the subscription ended (not a failed payment); deletesAt = retention end. */
  | { kind: 'cancelled'; deletesAt: string | null }
  | { kind: 'no_plan' };

export interface MeView {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    platformRole: string;
  };
  organisation: MeOrganisation;
  organisations: MeOrganisation[];
  plan: {
    tier: string;
    access: string;
    source: string;
    /** 26.1: Starter / Growth / Pro (absent without one). */
    studioPlan?: string;
    interval?: string;
  } | null;
  banner: AccountBanner | null;
  impersonating: boolean;
  /** Standalone shows sign-out and the organisation switcher; core mode signs in through Core. */
  identityMode: 'standalone' | 'core';
  /**
   * What the caller may do (the same list the API checks with requireCapability). The UI hides
   * controls the API would refuse; it never replaces the server check.
   */
  capabilities: string[];
}

interface SubscriptionState {
  status: string;
  trialEnd: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * The single banner to show, most urgent first. Pure; tested on its own. Read-only because the
 * subscription ended (canceled / expired, or no subscription left) is `cancelled`, with the date
 * the retention job hands the organisation to the purge when known; read-only for any other
 * reason (unpaid, grace over) is the payment-overdue `read_only`.
 */
export function accountBanner(
  entitlements: Pick<Entitlements, 'access' | 'source' | 'graceUntil'> | null,
  subscription: SubscriptionState | null,
  now: number,
  deletesAt: Date | null = null,
): AccountBanner | null {
  if (!entitlements) return null;
  if (entitlements.access === 'read_only') {
    if (!subscription || ENDED_STATUSES.has(subscription.status))
      return { kind: 'cancelled', deletesAt: deletesAt?.toISOString() ?? null };
    return { kind: 'read_only' };
  }
  if (subscription?.status === 'past_due')
    return { kind: 'past_due', graceUntil: entitlements.graceUntil?.toISOString() ?? null };
  if (entitlements.access === 'none') return { kind: 'no_plan' };
  if (
    (subscription?.status === 'trialing' || entitlements.source === 'trial') &&
    subscription?.trialEnd &&
    subscription.trialEnd.getTime() > now
  )
    return { kind: 'trial', endsAt: subscription.trialEnd.toISOString() };
  return null;
}

/**
 * When a cancelled organisation's data is scheduled for deletion: the retention clock
 * (org_entitlements.overrides.retention.cancelledAt, set by billing/sync.ts) plus
 * STUDIO_CANCELLED_RETENTION_DAYS. null when there is no clock, retention is off (0 days), the purge
 * was already requested, or the setting is invalid (the daily retention job reports that itself;
 * the banner must not break every page over it).
 */
export function cancelledDeletesAt(
  overridesRaw: unknown,
  env: Record<string, string | undefined> = process.env,
): Date | null {
  const retention = parseOverrides(overridesRaw).retention;
  if (!retention || retention.purgeRequestedAt) return null;
  const cancelledAt = Date.parse(retention.cancelledAt);
  if (Number.isNaN(cancelledAt)) return null;
  let days: number;
  try {
    days = cancelledRetentionDays(env);
  } catch (err) {
    if (err instanceof ConfigurationError) return null;
    throw err;
  }
  return days > 0 ? new Date(cancelledAt + days * DAY_MS) : null;
}

export async function getMe(
  deps: {
    db: PrismaClient;
    entitlements?: EntitlementsReader;
    modes?: StudioModes;
    now: () => number;
  },
  tenant: TenantContext,
): Promise<MeView> {
  const { db } = deps;
  const orgIds = [
    ...new Set([tenant.organisationId, ...tenant.memberships.map((m) => m.organisationId)]),
  ];
  const [user, orgs, subscription, entitlements, stored] = await Promise.all([
    db.user.findUnique({
      where: { id: tenant.userId },
      select: { name: true, email: true, role: true },
    }),
    db.organization.findMany({
      where: { id: { in: orgIds }, deletedAt: null },
      select: { id: true, name: true },
    }),
    db.subscription.findFirst({
      where: { organisationId: tenant.organisationId },
      orderBy: { updatedAt: 'desc' },
      select: { status: true, trialEnd: true },
    }),
    deps.entitlements?.forOrganisation(tenant.organisationId) ?? Promise.resolve(null),
    deps.entitlements
      ? db.orgEntitlement.findUnique({
          where: { organisationId: tenant.organisationId },
          select: { overrides: true },
        })
      : Promise.resolve(null),
  ]);
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  const roleIn = (orgId: string) =>
    tenant.memberships.find((m) => m.organisationId === orgId)?.role ?? null;
  const toOrg = (id: string): MeOrganisation => ({
    id,
    name: names.get(id) ?? id,
    role: roleIn(id),
  });
  return {
    user: {
      id: tenant.userId,
      name: user?.name ?? null,
      email: user?.email ?? null,
      platformRole: tenant.platformRole ?? user?.role ?? 'user',
    },
    organisation: { ...toOrg(tenant.organisationId), role: actorRole(tenant) ?? null },
    // Deleted organisations (not in `names`) are left out of the switcher, except the active one.
    organisations: orgIds.filter((id) => names.has(id)).map(toOrg),
    plan: entitlements
      ? {
          tier: entitlements.tier,
          access: entitlements.access,
          source: entitlements.source,
          ...(entitlements.plan && {
            studioPlan: entitlements.plan.id,
            interval: entitlements.plan.interval,
          }),
        }
      : null,
    banner: accountBanner(
      entitlements,
      subscription,
      deps.now(),
      cancelledDeletesAt(stored?.overrides ?? null),
    ),
    impersonating: Boolean(tenant.impersonatorUserId),
    identityMode: (deps.modes ?? studioModes()).identity,
    capabilities: [...tenant.capabilities],
  };
}
