import type Stripe from 'stripe';
import pino from 'pino';
import type { PrismaClient } from '@prisma/client';
import type { AuditEntry } from '../../src/lib/audit';
import { createMemoryAuthMailer } from '../../src/lib/email/auth-mailer';
import {
  LEGACY_REFERENCE_PRICES_PENCE,
  REFERENCE_PRICES_PENCE,
  planForLookupKey,
} from '../../src/lib/studio/billing/catalogue';
import type {
  ChargeState,
  CheckoutSessionState,
  InvoiceState,
  PlanChangePreview,
  PriceState,
  StripeGateway,
  SubscriptionState,
} from '../../src/lib/studio/billing/gateway';
import type { BillingInvoice } from '../../src/lib/studio/billing/contracts';
import { createStripeClient } from '../../src/lib/studio/billing/stripe-client';
import { webhookVerifier } from '../../src/lib/studio/billing/wiring';
import type { WebhookDeps } from '../../src/lib/studio/billing/webhook';

// A scripted Stripe for billing tests: in-memory customers, subscriptions, sessions, invoices,
// charges and prices behind the StripeGateway interface, plus REAL signed webhook deliveries
// (stripe.webhooks.generateTestHeaderString with the pinned SDK), so signature verification,
// dedupe and re-fetch run exactly as in production. The operator-run real test-mode run is
// scripts/billing/e2e-test-clock.ts.

export const WEBHOOK_SECRET = 'whsec_test_studio_fake_secret';
const signer = createStripeClient('sk_test_fake_for_signing_only');

export interface FakeStripe extends StripeGateway {
  subscriptions: Map<string, SubscriptionState>;
  sessions: Map<string, CheckoutSessionState>;
  invoices: Map<string, InvoiceState>;
  charges: Map<string, ChargeState>;
  events: Map<string, Stripe.Event>;
  prices: PriceState[];
  fingerprints: Map<string, string>;
  calls: Array<{ method: string; args: unknown[] }>;
  failNext?: { method: string; error: Error };
  /** 21.5: what the next invoices.createPreview answers (amount due now). */
  previewAmountPence: number;
  /** 21.5: the next immediate change's invoice is declined (pending_update, nothing applied). */
  declineNextChange?: boolean;
  /** Put a subscription in place (a test clock moving it). */
  setSubscription(
    state: Partial<SubscriptionState> & { id: string; customerId: string },
  ): SubscriptionState;
  /** A signed delivery for an event about `object` (the payload may be stale on purpose). */
  deliver(
    type: string,
    object: Record<string, unknown>,
    id?: string,
  ): { raw: string; signature: string; event: Stripe.Event };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq += 1)}`;

export function subscriptionState(
  partial: Partial<SubscriptionState> & { id: string; customerId: string },
): SubscriptionState {
  const lookupKey = partial.lookupKey === undefined ? 'studio_channel_monthly' : partial.lookupKey;
  return {
    status: 'active',
    lookupKey,
    priceId: `price_${lookupKey ?? 'custom'}`,
    itemId: `si_${partial.id}`,
    scheduleId: null,
    pendingChange: null,
    hasPendingUpdate: false,
    productTier: null,
    interval: (lookupKey && planForLookupKey(lookupKey)?.interval) || 'month',
    unitAmountPence: lookupKey
      ? (REFERENCE_PRICES_PENCE[lookupKey] ?? LEGACY_REFERENCE_PRICES_PENCE[lookupKey] ?? null)
      : null,
    quantity: 1,
    currency: 'gbp',
    currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    metadataOrganisationId: null,
    defaultPaymentMethodId: null,
    created: new Date('2026-09-01T00:00:00Z'),
    ...partial,
  };
}

export function referencePrices(): PriceState[] {
  return Object.entries({ ...REFERENCE_PRICES_PENCE, ...LEGACY_REFERENCE_PRICES_PENCE }).map(
    ([lookupKey, amount]) => ({
      id: `price_${lookupKey}`,
      lookupKey,
      unitAmountPence: amount,
      currency: 'gbp',
      interval: planForLookupKey(lookupKey)?.interval ?? null,
      active: true,
      productName: lookupKey,
      productTier: null,
      taxBehavior: 'exclusive',
    }),
  );
}

export function createFakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    subscriptions: new Map(),
    sessions: new Map(),
    invoices: new Map(),
    charges: new Map(),
    events: new Map(),
    prices: referencePrices(),
    fingerprints: new Map(),
    calls: [],
    previewAmountPence: 1_234,
    setSubscription(partial) {
      const state = subscriptionState(partial);
      fake.subscriptions.set(state.id, state);
      return state;
    },
    deliver(type, object, id = nextId('evt')) {
      const event = {
        id,
        object: 'event',
        type,
        api_version: '2026-08-26.dahlia',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        data: { object },
      } as unknown as Stripe.Event;
      fake.events.set(id, event);
      const raw = JSON.stringify(event);
      const signature = signer.webhooks.generateTestHeaderString({
        payload: raw,
        secret: WEBHOOK_SECRET,
      });
      return { raw, signature, event };
    },
    async createCustomer(input, idempotencyKey) {
      fake.calls.push({ method: 'createCustomer', args: [input, idempotencyKey] });
      return { id: `cus_${input.organisationId}` };
    },
    async createCheckoutSession(params, idempotencyKey) {
      fake.calls.push({ method: 'createCheckoutSession', args: [params, idempotencyKey] });
      const id = nextId('cs');
      return { id, url: `https://checkout.stripe.test/${id}` };
    },
    async retrieveCheckoutSession(id) {
      const s = fake.sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return s;
    },
    async createPortalSession(params) {
      fake.calls.push({ method: 'createPortalSession', args: [params] });
      return { url: `https://billing.stripe.test/p/${params.customer}` };
    },
    async retrieveSubscription(id) {
      fake.calls.push({ method: 'retrieveSubscription', args: [id] });
      if (fake.failNext?.method === 'retrieveSubscription') {
        const { error } = fake.failNext;
        fake.failNext = undefined;
        throw error;
      }
      return fake.subscriptions.get(id) ?? null;
    },
    async *listSubscriptions() {
      for (const s of fake.subscriptions.values()) yield s;
    },
    async endTrialNow(subscriptionId, idempotencyKey) {
      fake.calls.push({ method: 'endTrialNow', args: [subscriptionId, idempotencyKey] });
      const s = fake.subscriptions.get(subscriptionId);
      if (s) fake.subscriptions.set(subscriptionId, { ...s, status: 'active', trialEnd: null });
    },
    async cancelSubscription(subscriptionId, idempotencyKey) {
      fake.calls.push({ method: 'cancelSubscription', args: [subscriptionId, idempotencyKey] });
      const s = fake.subscriptions.get(subscriptionId);
      if (s) fake.subscriptions.set(subscriptionId, { ...s, status: 'canceled' });
    },
    async listInvoices(customerId, limit): Promise<BillingInvoice[]> {
      fake.calls.push({ method: 'listInvoices', args: [customerId, limit] });
      return [
        {
          id: 'in_1',
          number: 'STU-0001',
          status: 'paid',
          amountDuePence: 9_900,
          currency: 'gbp',
          createdAt: '2026-09-01T00:00:00.000Z',
          hostedInvoiceUrl: 'https://invoice.stripe.test/in_1',
          invoicePdfUrl: 'https://invoice.stripe.test/in_1.pdf',
        },
      ];
    },
    async retrieveInvoice(id) {
      const inv = fake.invoices.get(id);
      if (!inv) throw new Error(`no invoice ${id}`);
      return inv;
    },
    async listPrices(lookupKeys) {
      fake.calls.push({ method: 'listPrices', args: [lookupKeys] });
      return fake.prices.filter((p) => p.lookupKey && lookupKeys.includes(p.lookupKey));
    },
    async paymentMethodFingerprint(paymentMethodId) {
      return fake.fingerprints.get(paymentMethodId) ?? null;
    },
    async customerDefaultPaymentMethod() {
      return null;
    },
    async retrieveCharge(id) {
      const c = fake.charges.get(id);
      if (!c) throw new Error(`no charge ${id}`);
      return c;
    },
    async retrieveEvent(id) {
      const e = fake.events.get(id);
      if (!e) throw new Error(`no event ${id}`);
      return e;
    },
    async markCustomerDeleted(customerId) {
      fake.calls.push({ method: 'markCustomerDeleted', args: [customerId] });
    },
    async previewPlanChange(change): Promise<PlanChangePreview> {
      fake.calls.push({ method: 'previewPlanChange', args: [change] });
      return {
        amountDuePence: fake.previewAmountPence,
        totalPence: fake.previewAmountPence,
        taxPence: 0,
        currency: 'gbp',
        prorationDate: change.prorationDate,
      };
    },
    async changePlanNow(change, idempotencyKey) {
      fake.calls.push({ method: 'changePlanNow', args: [change, idempotencyKey] });
      const s = fake.subscriptions.get(change.subscriptionId);
      if (!s) throw new Error(`no subscription ${change.subscriptionId}`);
      if (fake.declineNextChange) {
        fake.declineNextChange = false;
        const pending = { ...s, hasPendingUpdate: true };
        fake.subscriptions.set(s.id, pending);
        return pending;
      }
      const price = fake.prices.find((p) => p.id === change.priceId);
      const next: SubscriptionState = {
        ...s,
        priceId: change.priceId,
        lookupKey: price?.lookupKey ?? s.lookupKey,
        interval: price?.interval ?? s.interval,
        unitAmountPence: price?.unitAmountPence ?? s.unitAmountPence,
        quantity: change.quantity,
        hasPendingUpdate: false,
      };
      fake.subscriptions.set(s.id, next);
      return next;
    },
    async schedulePlanChange(change, idempotencyKey) {
      fake.calls.push({ method: 'schedulePlanChange', args: [change, idempotencyKey] });
      const s = fake.subscriptions.get(change.subscriptionId);
      if (!s) throw new Error(`no subscription ${change.subscriptionId}`);
      const price = fake.prices.find((p) => p.id === change.priceId);
      fake.subscriptions.set(s.id, {
        ...s,
        scheduleId: nextId('sub_sched'),
        pendingChange: {
          quantity: change.quantity,
          priceId: change.priceId,
          lookupKey: price?.lookupKey ?? null,
          effectiveAt: s.currentPeriodEnd ?? new Date(),
        },
      });
    },
    async releaseSchedule(scheduleId, idempotencyKey) {
      fake.calls.push({ method: 'releaseSchedule', args: [scheduleId, idempotencyKey] });
      for (const s of fake.subscriptions.values())
        if (s.scheduleId === scheduleId)
          fake.subscriptions.set(s.id, { ...s, scheduleId: null, pendingChange: null });
    },
    async setCancelAtPeriodEnd(subscriptionId, cancel, idempotencyKey) {
      fake.calls.push({
        method: 'setCancelAtPeriodEnd',
        args: [subscriptionId, cancel, idempotencyKey],
      });
      const s = fake.subscriptions.get(subscriptionId);
      if (s) fake.subscriptions.set(subscriptionId, { ...s, cancelAtPeriodEnd: cancel });
    },
  };
  return fake;
}

export function webhookDepsFor(
  db: PrismaClient,
  fake: FakeStripe,
  options: { now?: () => number; env?: Record<string, string | undefined> } = {},
): WebhookDeps & { audits: AuditEntry[]; mailer: ReturnType<typeof createMemoryAuthMailer> } {
  const audits: AuditEntry[] = [];
  const mailer = createMemoryAuthMailer();
  return {
    db,
    gateway: fake,
    constructEvent: webhookVerifier(signer, WEBHOOK_SECRET),
    logger: pino({ level: 'silent' }),
    audit: (entry) => audits.push(entry),
    now: options.now ?? Date.now,
    env: options.env ?? {},
    mailer,
    audits,
  };
}

/** A Stripe subscription object payload as an event carries it (only the fields we read: id). */
export function subscriptionPayload(state: SubscriptionState, status = state.status) {
  return { id: state.id, object: 'subscription', customer: state.customerId, status };
}
