// Phase 18 §P.3 / §P.4 sample handlers for the admin Billing tab (Track C):
//   GET|PUT|DELETE /admin/organisations/:id/entitlements   services: billing/admin.ts
//   GET /admin/billing/subscriptions                       listAdminSubscriptions (MRR)
// An ENTERPRISE override needs the agreed monthly price, at least the §P.2 minimum for the
// monthly cost cap (the real enterpriseMinimumMonthlyPricePence: £1,100 cap → £1,416), else 422.
// Saving ENTERPRISE for the demo organisation switches the demo bar's plan to Enterprise.
import {
  ENTERPRISE_LIST_PRICE_PENCE,
  PLAN_CATALOGUE,
  enterpriseMinimumMonthlyPricePence,
  planForLookupKey,
} from '@/lib/studio/billing/catalogue';
import type { PlanTier } from '@/components/studio/billing/types';
import { BILLING_STATE_INFO, getBillingState, setBillingState } from '../billing-state';
import { DEMO_ORG_ID, DEMO_USER_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { ADMIN_ORGS, graceFor, syncDemoOrg, type AdminOrg } from './p18-admin';
import { referencePrice } from './p18-billing';
import { ago, DAY } from './projects-store';
import {
  channelPlanOf,
  endedTrials,
  overrideActive,
  overrides,
  planSummary,
  trialView,
} from './admin-plan-state';
import {
  channelIntervalForLookupKey,
  isChannelInterval,
  isValidChannelCount,
} from '@/lib/studio/billing/channel-plan';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const ENTERPRISE_CAP = PLAN_CATALOGUE.ENTERPRISE.monthlyCostCapPence;

function findOrg(id: string | undefined): AdminOrg {
  syncDemoOrg();
  const org = ADMIN_ORGS.find((o) => o.id === id);
  if (!org) throw new DemoHttpError(404, 'not_found', 'Organisation not found');
  return org;
}

const isTier = (v: unknown): v is PlanTier =>
  v === 'BASIC' || v === 'STANDARD' || v === 'PLUS' || v === 'ENTERPRISE';

function view(org: AdminOrg) {
  const own = overrideActive(org.id);
  const tier: PlanTier = own?.tier ?? (isTier(org.tier) ? org.tier : 'BASIC');
  const access = own?.access ?? (org.access as 'full' | 'read_only' | 'none' | null) ?? 'none';
  const plan = PLAN_CATALOGUE[tier];
  const custom = own?.limits;
  const pick = (key: 'seats' | 'businesses' | 'storageGb', fallback: number | null) =>
    custom && key in custom ? (custom[key] ?? null) : fallback;
  const demoState = org.id === DEMO_ORG_ID ? BILLING_STATE_INFO[getBillingState()] : null;
  const source = own ? 'admin' : (demoState?.source ?? planSummary(org).source);
  const channelPlan = channelPlanOf(org);
  return {
    organisationId: org.id,
    effective: {
      tier,
      access,
      source,
      ...(graceFor(org) && { graceUntil: graceFor(org) as string }),
      limits: {
        seats: pick('seats', plan.seats),
        businesses: pick('businesses', plan.businesses),
        storageGb: pick('storageGb', plan.storageGb),
      },
      ...(custom && { custom }),
      ...(org.subscriptionStatus && { subscriptionStatus: org.subscriptionStatus }),
      ...(channelPlan && { channelPlan }),
    },
    stored: org.tier
      ? {
          tier: org.tier,
          access: org.access ?? 'none',
          source: org.subscriptionStatus === 'trialing' ? 'trial' : 'stripe',
          graceUntil: graceFor(org),
          trialStartedAt: org.subscriptionStatus === 'trialing' ? ago(5 * DAY) : null,
          everPaidAt: org.subscriptionStatus === 'trialing' ? null : ago(30 * DAY),
          updatedAt: ago(DAY),
        }
      : null,
    admin: overrides.get(org.id) ?? null,
    limits: custom ?? null,
    trial: trialView(org),
    enterprise: {
      monthlyCapPence: ENTERPRISE_CAP,
      minimumMonthlyPricePence: enterpriseMinimumMonthlyPricePence(ENTERPRISE_CAP),
    },
    subscriptions: org.subscriptionStatus
      ? [
          {
            id: `sub_${org.slug}`,
            status: org.subscriptionStatus,
            tier: org.lookupKey ? (planForLookupKey(org.lookupKey)?.tier ?? null) : tier,
            interval: channelIntervalForLookupKey(org.lookupKey) ?? 'month',
            quantity: org.channels ?? 1,
            currentPeriodEnd: future(20),
            cancelAtPeriodEnd: false,
          },
        ]
      : [],
  };
}

route('GET', '/admin/organisations/:id/entitlements', ({ params }) => ({
  entitlements: view(findOrg(params.id)),
}));

route('PUT', '/admin/organisations/:id/entitlements', ({ params, body }) => {
  const org = findOrg(params.id);
  const input = obj(body);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) throw bad('reason: Too small');
  if (input.tier !== undefined && !isTier(input.tier)) throw bad('tier: Invalid option');
  if (input.channels !== undefined && !isValidChannelCount(input.channels))
    throw bad('channels: Choose between 1 and 6 channels');
  if (input.interval !== undefined && !isChannelInterval(input.interval))
    throw bad('interval: Invalid option');
  const access = input.access;
  if (access !== undefined && access !== 'full' && access !== 'read_only' && access !== 'none')
    throw bad('access: Invalid option');
  const tier = (input.tier as PlanTier | undefined) ?? (isTier(org.tier) ? org.tier : 'BASIC');
  const price = typeof input.monthlyPricePence === 'number' ? input.monthlyPricePence : null;
  // 20.27: End the trial now (as billing/admin.ts: refused without a running trial; on its own it
  // leaves the override as it is).
  const endTrial = input.endTrial === true;
  const onlyEndTrial =
    endTrial &&
    input.tier === undefined &&
    access === undefined &&
    input.limits === undefined &&
    input.channels === undefined &&
    input.interval === undefined &&
    price === null &&
    typeof input.expiresAt !== 'string';
  if (endTrial) {
    const trial = trialView(org);
    if (!trial) throw bad('This organisation has no trial to end');
    if (trial.state === 'ended') throw bad('This trial was already ended');
  }
  const markEnded = () =>
    endTrial &&
    endedTrials.set(org.id, { endedAt: new Date().toISOString(), endedByUserId: DEMO_USER_ID });
  if (onlyEndTrial) {
    markEnded();
    return { entitlements: view(org) };
  }
  if (tier === 'ENTERPRISE') {
    const minimum = enterpriseMinimumMonthlyPricePence(ENTERPRISE_CAP);
    if (price === null || price < minimum)
      throw new DemoHttpError(
        422,
        'unprocessable',
        `The monthly price must be at least ${minimum} pence for a ${ENTERPRISE_CAP} pence monthly cost cap`,
        { reason: 'below_minimum_price', minimumMonthlyPricePence: minimum },
      );
  }
  overrides.set(org.id, {
    ...(input.tier !== undefined && { tier }),
    ...(isValidChannelCount(input.channels) && { channels: input.channels }),
    ...(isChannelInterval(input.interval) && { interval: input.interval }),
    ...(access !== undefined && { access }),
    ...(input.limits !== undefined && { limits: obj(input.limits) as Record<string, number> }),
    monthlyPricePence: tier === 'ENTERPRISE' ? price : null,
    expiresAt: typeof input.expiresAt === 'string' ? input.expiresAt : null,
    reason,
    setByUserId: DEMO_USER_ID,
    setAt: new Date().toISOString(),
  });
  markEnded();
  if (org.id === DEMO_ORG_ID && tier === 'ENTERPRISE') setBillingState('enterprise');
  return { entitlements: view(org) };
});

route('DELETE', '/admin/organisations/:id/entitlements', ({ params, body }) => {
  const org = findOrg(params.id);
  if (String(obj(body).reason ?? '').trim().length < 3) throw bad('reason: Too small');
  overrides.delete(org.id);
  if (org.id === DEMO_ORG_ID && getBillingState() === 'enterprise')
    setBillingState('active_monthly');
  syncDemoOrg();
  return { entitlements: view(org) };
});

const MRR_STATUSES = new Set(['active', 'past_due']);

route('GET', '/admin/billing/subscriptions', ({ query }) => {
  syncDemoOrg();
  const status = query.get('status') ?? '';
  const rows = ADMIN_ORGS.filter((o) => o.subscriptionStatus).map((o) => {
    const own = overrides.get(o.id);
    const plan = o.lookupKey ? planForLookupKey(o.lookupKey) : undefined;
    const tier: PlanTier | null = own?.tier ?? plan?.tier ?? (isTier(o.tier) ? o.tier : null);
    const interval = plan?.interval ?? 'month';
    // 21.5: a channel price is per channel (quantity = channels).
    const amount =
      tier === 'ENTERPRISE'
        ? (own?.monthlyPricePence ?? ENTERPRISE_LIST_PRICE_PENCE)
        : o.lookupKey
          ? referencePrice(o.lookupKey) * (o.channels ?? 1)
          : 0;
    const mrrPence = MRR_STATUSES.has(o.subscriptionStatus ?? '')
      ? interval === 'year'
        ? Math.round(amount / 12)
        : interval === 'week'
          ? Math.round((amount * 52) / 12)
          : amount
      : 0;
    return {
      id: `sub_${o.slug}`,
      organisationId: o.id,
      organisationName: o.name,
      status: o.subscriptionStatus as string,
      tier,
      interval,
      mrrPence,
      currentPeriodEnd: future(20),
      cancelAtPeriodEnd: false,
      trialEnd: o.subscriptionStatus === 'trialing' ? future(9) : null,
    };
  });
  const byStatus: Record<string, number> = {};
  const byTier: Record<PlanTier, { count: number; mrrPence: number }> = {
    BASIC: { count: 0, mrrPence: 0 },
    STANDARD: { count: 0, mrrPence: 0 },
    PLUS: { count: 0, mrrPence: 0 },
    ENTERPRISE: { count: 0, mrrPence: 0 },
  };
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.tier) {
      byTier[r.tier].count += 1;
      byTier[r.tier].mrrPence += r.mrrPence;
    }
  }
  const shown = rows.filter((r) => !status || r.status === status);
  return {
    summary: {
      mrrPence: rows.reduce((sum, r) => sum + r.mrrPence, 0),
      currency: 'gbp',
      byStatus,
      byTier,
      total: rows.length,
    },
    subscriptions: shown,
  };
});
