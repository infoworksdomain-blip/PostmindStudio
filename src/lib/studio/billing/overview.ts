import type { PrismaClient } from '@prisma/client';
import { costCapsFromEnv, utcMonthKey, utcMonthRange } from '../cost/caps';
import type { CapAdjustment } from '../cost/guard';
import { resolveOrgCap } from '../cost/org-overrides';
import type { PlanTier } from '../providers/router';
import { CATALOGUE_VERSION } from './catalogue';
import { capAdjustmentFor } from './cost-adjustments';
import { availableCredits } from './credits';
import type { CustomLimits, TrialState } from './entitlements';
import type { EntitlementLimits, EntitlementsReader } from './entitlements-reader';
import { trialEligible } from './service';
import { governingSubscription } from './sync';
import type { TenantAccess } from '../../tenant';

// Phase 18 §3 /settings/billing — GET /api/studio/billing: plan and status, the subscription,
// usage against every plan limit (seats, businesses, storage, cost this month vs cap), top-up
// credits. Video quotas come from the existing GET /usage (plan-quotas.ts usageView).

const GB = 1024 ** 3;

export interface Meter {
  used: number;
  limit: number | null;
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
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
  } | null;
  hasBillingAccount: boolean;
  trialEligible: boolean;
  credits: { short: number; long: number };
  usage: {
    seats: Meter;
    businesses: Meter;
    /** Bytes as a string (BigInt-safe); warn-only in Phase 18. */
    storage: { usedBytes: string; limitGb: number | null; percent: number | null };
    cost: {
      month: string;
      spentPence: number;
      capPence: number | null;
      headroomPence: number;
    };
  };
}

type OverviewDb = Pick<
  PrismaClient,
  | 'subscription'
  | 'billingCustomer'
  | 'orgEntitlement'
  | 'usageCredit'
  | 'usageCreditUse'
  | 'member'
  | 'business'
  | 'videoAsset'
  | 'providerUsage'
  | 'orgCostCap'
>;

async function monthlyCap(
  db: OverviewDb,
  organisationId: string,
  tier: PlanTier,
  adjustment: CapAdjustment | null,
): Promise<number | null> {
  if (adjustment?.trial) return adjustment.trial.monthlyPence;
  const override = await db.orgCostCap.findUnique({ where: { organisationId } });
  const cap = resolveOrgCap('monthly', costCapsFromEnv(), tier, override);
  return cap.pence === undefined ? null : cap.pence + (adjustment?.monthlyHeadroomPence ?? 0);
}

export async function billingOverview(
  deps: { db: OverviewDb; entitlements: EntitlementsReader; now: () => number },
  organisationId: string,
): Promise<BillingOverview> {
  const now = new Date(deps.now());
  const ent = await deps.entitlements.forOrganisation(organisationId);
  const { start, end } = utcMonthRange(now);
  const [subs, customer, credits, seats, businesses, storage, spend, adjustment, eligible] =
    await Promise.all([
      deps.db.subscription.findMany({ where: { organisationId } }),
      deps.db.billingCustomer.findUnique({ where: { organisationId } }),
      availableCredits(deps.db, organisationId, now),
      deps.db.member.count({ where: { organizationId: organisationId } }),
      deps.db.business.count({ where: { organisationId, deletedAt: null } }),
      deps.db.videoAsset.aggregate({ where: { organisationId }, _sum: { fileSizeBytes: true } }),
      deps.db.providerUsage.aggregate({
        where: { organisationId, day: { gte: start, lt: end } },
        _sum: { costPence: true },
      }),
      capAdjustmentFor(deps.db, deps.entitlements, organisationId, now),
      trialEligible(deps.db, organisationId),
    ]);
  const sub = governingSubscription(subs);
  const usedBytes = storage._sum.fileSizeBytes ?? BigInt(0);
  const limitGb = ent.limits.storageGb;
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
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          trialEnd: sub.trialEnd?.toISOString() ?? null,
        }
      : null,
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
      cost: {
        month: utcMonthKey(now),
        spentPence: spend._sum.costPence ?? 0,
        capPence: await monthlyCap(deps.db, organisationId, ent.tier, adjustment),
        headroomPence: adjustment?.monthlyHeadroomPence ?? 0,
      },
    },
  };
}
