import type { PrismaClient } from '@prisma/client';
import { studioModes, type StudioModes } from '../../mode';
import type { TenantContext } from '../../tenant';
import type { Entitlements, EntitlementsReader } from '../billing/entitlements-reader';
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
  plan: { tier: string; access: string; source: string } | null;
  banner: AccountBanner | null;
  impersonating: boolean;
  /** Standalone shows sign-out and the organisation switcher; core mode signs in through Core. */
  identityMode: 'standalone' | 'core';
}

interface SubscriptionState {
  status: string;
  trialEnd: Date | null;
}

/** The single banner to show, most urgent first. Pure; tested on its own. */
export function accountBanner(
  entitlements: Pick<Entitlements, 'access' | 'source' | 'graceUntil'> | null,
  subscription: SubscriptionState | null,
  now: number,
): AccountBanner | null {
  if (!entitlements) return null;
  if (entitlements.access === 'read_only') return { kind: 'read_only' };
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
  const [user, orgs, subscription, entitlements] = await Promise.all([
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
      ? { tier: entitlements.tier, access: entitlements.access, source: entitlements.source }
      : null,
    banner: accountBanner(entitlements, subscription, deps.now()),
    impersonating: Boolean(tenant.impersonatorUserId),
    identityMode: (deps.modes ?? studioModes()).identity,
  };
}
