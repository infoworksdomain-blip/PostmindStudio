import type { PrismaClient, Subscription } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import { CATALOGUE_VERSION } from './catalogue';
import { planOfSubscription, type PlanId, type PlanInterval } from './plans';
import { availableCredits } from './credits';
import type { CustomLimits, TrialState } from './entitlements';
import type { EntitlementLimits, EntitlementsReader } from './entitlements-reader';
import { currentPlan } from './plan-change';
import { trialEligible } from './service';
import { governingSubscription } from './sync';
import type { TenantAccess } from '../../tenant';

// Phase 18 §3 / 26.1 "Your plan" — GET /api/studio/billing: plan and status, the subscription
// (plan, interval, price, renewal, a change waiting for the end of the period), usage against the
// plan limits (seats, businesses, storage), video-pack credits. Video allowance used / included comes from GET /usage.
// 21.5: generation cost is never shown to customers, so the overview has no cost or budget
// figures (staff see them in the Admin Centre).

const GB = 1024 ** 3;

export interface Meter {
  used: number;
  limit: number | null;
}

export interface PlanView {
  id: PlanId;
  interval: PlanInterval;
  /** 'admin' = staff set the plan / interval (no Stripe change to make). */
  source: 'stripe' | 'admin';
  /** A legacy price (21.5 channels or an old tier) shown as its plan until the migration. */
  legacy: boolean;
  /** What the subscription bills per period, excl. VAT (null without a Stripe price). */
  pricePerPeriodPence: number | null;
  currency: string | null;
  /** The change waiting for the end of the period (a lower plan or a shorter interval). */
  pending: { plan: PlanId; interval: PlanInterval; effectiveAt: string } | null;
  /** An upgrade whose invoice is not paid yet (applies once it is). */
  paymentPending: boolean;
}

export interface BillingOverview {
  catalogueVersion: string;
  entitlements: {
    tier: PlanTier;
    access: TenantAccess;
    source: string;
    graceUntil: string | null;
    limits: EntitlementLimits;
    custom: CustomLimits | null;
    trial: TrialState | null;
    subscriptionStatus: string | null;
  };
  subscription: {
    status: string;
    lookupKey: string | null;
    interval: string | null;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
  } | null;
  /** 26.1: Starter / Growth / Pro (null: no plan, ENTERPRISE or a custom staff plan). */
  plan: PlanView | null;
  hasBillingAccount: boolean;
  trialEligible: boolean;
  credits: { short: number; long: number };
  usage: {
    seats: Meter;
    businesses: Meter;
    /** Bytes as a string (BigInt-safe); warn-only in Phase 18. */
    storage: { usedBytes: string; limitGb: number | null; percent: number | null };
  };
}

type OverviewDb = Pick<
  PrismaClient,
  | 'subscription'
  | 'billingCustomer'
  | 'orgEntitlement'
  | 'usageCredit'
  | 'member'
  | 'business'
  | 'videoAsset'
>;

function pendingOf(sub: Subscription | null): PlanView['pending'] {
  if (!sub?.pendingEffectiveAt) return null;
  const next = planOfSubscription({
    lookupKey: sub.pendingLookupKey,
    quantity: sub.pendingQuantity,
  });
  if (!next) return null;
  return {
    plan: next.plan,
    interval: next.interval,
    effectiveAt: sub.pendingEffectiveAt.toISOString(),
  };
}

export async function billingOverview(
  deps: { db: OverviewDb; entitlements: EntitlementsReader; now: () => number },
  organisationId: string,
): Promise<BillingOverview> {
  const now = new Date(deps.now());
  const ent = await deps.entitlements.forOrganisation(organisationId);
  const [subs, customer, credits, seats, businesses, storage, eligible, legacyPlan] =
    await Promise.all([
      deps.db.subscription.findMany({ where: { organisationId } }),
      deps.db.billingCustomer.findUnique({ where: { organisationId } }),
      availableCredits(deps.db, organisationId, now),
      deps.db.member.count({ where: { organizationId: organisationId } }),
      deps.db.business.count({ where: { organisationId, deletedAt: null } }),
      deps.db.videoAsset.aggregate({ where: { organisationId }, _sum: { fileSizeBytes: true } }),
      trialEligible(deps.db, organisationId),
      currentPlan(deps.db, organisationId),
    ]);
  const sub = governingSubscription(subs);
  const usedBytes = storage._sum.fileSizeBytes ?? BigInt(0);
  const limitGb = ent.limits.storageGb;
  const entPlan = ent.plan;
  const planId = entPlan?.id ?? (legacyPlan?.legacy ? legacyPlan.plan : null);
  const plan: PlanView | null =
    planId === null
      ? null
      : {
          id: planId,
          interval: entPlan?.interval ?? legacyPlan?.interval ?? 'month',
          source: entPlan?.source ?? 'stripe',
          legacy: Boolean(legacyPlan?.legacy) && entPlan?.source !== 'admin',
          pricePerPeriodPence:
            sub?.unitAmountPence != null ? sub.unitAmountPence * sub.quantity : null,
          currency: sub?.currency ?? null,
          pending: pendingOf(sub),
          paymentPending: Boolean(sub?.pendingUpdate),
        };
  return {
    catalogueVersion: CATALOGUE_VERSION,
    entitlements: {
      tier: ent.tier,
      access: ent.access,
      source: ent.source,
      graceUntil: ent.graceUntil?.toISOString() ?? null,
      limits: ent.limits,
      custom: ent.custom ?? null,
      trial: ent.trial ?? null,
      subscriptionStatus: ent.subscriptionStatus ?? null,
    },
    subscription: sub
      ? {
          status: sub.status,
          lookupKey: sub.lookupKey,
          interval: sub.interval,
          quantity: sub.quantity,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          trialEnd: sub.trialEnd?.toISOString() ?? null,
        }
      : null,
    plan,
    hasBillingAccount: Boolean(customer && !customer.deletedAt),
    trialEligible: eligible,
    credits,
    usage: {
      seats: { used: seats, limit: ent.limits.seats },
      businesses: { used: businesses, limit: ent.limits.businesses },
      storage: {
        usedBytes: usedBytes.toString(),
        limitGb,
        percent: limitGb ? Math.round((Number(usedBytes) / (limitGb * GB)) * 100) : null,
      },
    },
  };
}
