import type { AdminEntitlementView } from '@/lib/studio/billing/admin';
import type { BillingInvoice } from '@/lib/studio/billing/contracts';
import type { Entitlements } from '@/lib/studio/billing/entitlements-reader';
import type { BillingOverview } from '@/lib/studio/billing/overview';
import type { PricingView } from '@/lib/studio/billing/pricing';
import type { PlanTier } from '@/lib/studio/providers/router';

// Phase 18 Track C — the JSON the billing screens read. Types only: the server modules are never
// bundled into the browser.

export type { PlanTier, PricingView };
export type { PlanPricingView, TopUpPricingView } from '@/lib/studio/billing/pricing';
export type { BillingInterval, SelfServeTier } from '@/lib/studio/billing/catalogue';

/** GET /api/studio/billing */
export interface BillingResponse {
  billing: BillingOverview & { canManage: boolean; checkoutEnabled: boolean };
}

/** GET /api/studio/billing/plans */
export interface PlansResponse {
  pricing: PricingView;
}

/** GET /api/studio/billing/invoices */
export interface InvoicesResponse {
  invoices: BillingInvoice[];
}

export type { BillingInvoice };

/** Dates cross the wire as ISO strings. */
export type EffectiveEntitlements = Omit<Entitlements, 'graceUntil'> & { graceUntil?: string };

/** GET|PUT|DELETE /api/studio/admin/organisations/:id/entitlements */
export interface AdminEntitlementsResponse {
  entitlements: Omit<AdminEntitlementView, 'effective'> & { effective: EffectiveEntitlements };
}

export interface AdminSubscriptionRow {
  id: string;
  organisationId: string;
  organisationName: string | null;
  status: string;
  tier: PlanTier | null;
  interval: string | null;
  mrrPence: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}

/** GET /api/studio/admin/billing/subscriptions */
export interface AdminSubscriptionsResponse {
  summary: {
    mrrPence: number;
    currency: string;
    byStatus: Record<string, number>;
    byTier: Record<PlanTier, { count: number; mrrPence: number }>;
    total: number;
  };
  subscriptions: AdminSubscriptionRow[];
}

export const PLAN_TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);
}

/** Subscription statuses with a catalogue label (billing.subscriptionStatus.*). */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** A subscription that still governs the organisation (so a new Checkout would conflict). */
export function isLiveSubscription(status: string | null | undefined): boolean {
  return (
    typeof status === 'string' &&
    status !== '' &&
    !['canceled', 'incomplete_expired', 'incomplete'].includes(status)
  );
}
