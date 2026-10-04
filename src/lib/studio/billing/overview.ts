import type { PrismaClient, Subscription } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import { CATALOGUE_VERSION } from './catalogue';
import { channelIntervalForLookupKey, type ChannelInterval } from './channel-plan';
import { loadChannelUsage, type ChannelUsage } from './channels';
import { availableCredits } from './credits';
import type { CustomLimits, TrialState } from './entitlements';
import type { EntitlementLimits, EntitlementsReader } from './entitlements-reader';
import { currentPlan } from './plan-change';
import { trialEligible } from './service';
import { governingSubscription } from './sync';
import type { TenantAccess } from '../../tenant';

// Phase 18 §3 / 21.5 "Your plan" — GET /api/studio/billing: plan and status, the subscription
// (channels, interval, price, renewal, a change waiting for the end of the period), the
// connected channels against the paid ones, usage against the plan limits (seats, businesses,
// storage), video-pack credits. Video allowance used / included comes from GET /usage.
// 21.5: generation cost is never shown to customers, so the overview has no cost or budget
// figures (staff see them in the Admin Centre).

const GB = 1024 ** 3;

export interface Meter {
  used: number;
  limit: number | null;
}

export interface PlanView {
  channels: number;
  interval: ChannelInterval;
  /** 'admin' = staff set the channels / interval (no Stripe change to make). */
  source: 'stripe' | 'admin';
  /** A legacy tier subscription shown as channels (until the ops migration moves it). */
  legacy: boolean;
  /** What the subscription bills per period, excl. VAT (null without a Stripe price). */
  pricePerPeriodPence: number | null;
  currency: string | null;
  /** The change waiting for the end of the period (fewer channels or a shorter interval). */
  pending: { channels: number; interval: ChannelInterval | null; effectiveAt: string } | null;
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
  /** 21.5: the per-channel plan (null: no plan, ENTERPRISE or a custom staff plan). */
  plan: PlanView | null;
  /** 21.5: connected platforms against the paid channels (null without a channel plan). */
  channels: ChannelUsage | null;
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
  | 'platformConnection'
>;

function pendingOf(sub: Subscription | null): PlanView['pending'] {
  if (!sub?.pendingQuantity || !sub.pendingEffectiveAt) return null;
  return {
    channels: sub.pendingQuantity,
    interval: channelIntervalForLookupKey(sub.pendingLookupKey) ?? null,
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
  const channelPlan = ent.channelPlan;
  const planChannels = channelPlan?.channels ?? (legacyPlan?.legacy ? legacyPlan.channels : null);
  const plan: PlanView | null =
    planChannels === null
      ? null
      : {
          channels: planChannels,
          interval: channelPlan?.interval ?? legacyPlan?.interval ?? 'month',
          source: channelPlan?.source ?? 'stripe',
          legacy: !channelPlan && Boolean(legacyPlan?.legacy),
          pricePerPeriodPence:
            sub?.unitAmountPence != null ? sub.unitAmountPence * sub.quantity : null,
          currency: sub?.currency ?? null,
          pending: pendingOf(sub),
          paymentPending: Boolean(sub?.pendingUpdate),
        };
  const channels = channelPlan
    ? await loadChannelUsage(deps.db, organisationId, channelPlan.channels)
    : null;
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
    channels,
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
