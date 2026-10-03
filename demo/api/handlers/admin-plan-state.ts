// 20.27 sample state shared by the admin Organisations list / detail (p18-admin.ts) and the
// entitlements handlers (p18-admin-billing.ts): staff overrides and trials staff ended. Shapes
// follow src/lib/studio/billing/admin.ts (AdminTrialView) and services/admin-directory.ts
// (planSummary). Kept in its own module so neither handler file imports the other.
import { TRIAL } from '@/lib/studio/billing/catalogue';
import type { PlanTier } from '@/components/studio/billing/types';
import { ago, DAY } from './projects-store';

export interface DemoOverride {
  tier?: PlanTier;
  access?: 'full' | 'read_only' | 'none';
  limits?: Record<string, number | null>;
  monthlyPricePence?: number | null;
  expiresAt?: string | null;
  reason: string;
  setByUserId: string;
  setAt: string;
}

/** The fields of an admin organisation row the plan summary needs. */
export interface PlanOrg {
  id: string;
  tier: string | null;
  access: string | null;
  subscriptionStatus: string | null;
  costThisMonthPence: number;
}

export const overrides = new Map<string, DemoOverride>();
/** organisationId → when staff ended its trial, and who. */
export const endedTrials = new Map<string, { endedAt: string; endedByUserId: string }>();

const TRIAL_STARTED_DAYS_AGO = 5;
const TRIAL_DAYS = 14;
const TRIAL_SPENT_SAMPLE_PENCE = 1_496;

const isTier = (v: unknown): v is PlanTier =>
  v === 'BASIC' || v === 'STANDARD' || v === 'PLUS' || v === 'ENTERPRISE';

export function overrideActive(id: string): DemoOverride | undefined {
  const own = overrides.get(id);
  if (!own) return undefined;
  return own.expiresAt && Date.parse(own.expiresAt) <= Date.now() ? undefined : own;
}

/** The trial as staff see it, or null when the organisation is not on a Stripe trial. */
export function trialView(org: PlanOrg) {
  if (org.subscriptionStatus !== 'trialing') return null;
  const ended = endedTrials.get(org.id);
  const startedAt = ago(TRIAL_STARTED_DAYS_AGO * DAY);
  return {
    state: ended
      ? ('ended' as const)
      : overrideActive(org.id)
        ? ('overridden' as const)
        : ('running' as const),
    startedAt,
    endsAt: new Date(Date.parse(startedAt) + TRIAL_DAYS * DAY).toISOString(),
    endedAt: ended?.endedAt ?? null,
    endedByUserId: ended?.endedByUserId ?? null,
    dailyCostCapPence: TRIAL.dailyCostCapPence,
    totalCostCapPence: TRIAL.totalCostCapPence,
    // The guard stops a trial at its £15 total, so the sample sits just under it (the
    // operator's "stuck" case).
    spentPence: Math.min(org.costThisMonthPence, TRIAL_SPENT_SAMPLE_PENCE),
  };
}

/** Plan, access, source and trial as the list and detail show them (planSummary). */
export function planSummary(org: PlanOrg) {
  const own = overrideActive(org.id);
  const trial = trialView(org);
  return {
    tier: own?.tier ?? (isTier(org.tier) ? org.tier : null),
    access: own?.access ?? org.access,
    source: own
      ? 'admin'
      : org.subscriptionStatus === 'trialing'
        ? 'trial'
        : org.tier
          ? 'stripe'
          : 'none',
    trial: trial ? { state: trial.state, endsAt: trial.endsAt } : null,
  };
}
