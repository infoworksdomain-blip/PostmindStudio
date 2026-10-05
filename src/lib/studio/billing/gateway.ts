import type Stripe from 'stripe';
import { UpstreamServiceError } from '../../errors';
import type { BillingInvoice } from './contracts';
import { listPricesByLookupKeys } from './stripe-lookup';

// Phase 18 §2.7 — the narrow slice of the Stripe API Studio uses, behind an interface so the
// billing logic is tested against a scripted fake (billing/testing/fake-gateway.ts) and the real
// SDK shapes are converted in exactly one place. Field names follow the pinned API version
// (stripe-client.ts, 2026-08-26.dahlia):
//   - subscription period: items.data[].current_period_start / current_period_end
//     https://docs.stripe.com/api/subscription_items/object (read 2026-09-29)
//   - invoice → subscription: invoice.parent.subscription_details.subscription
//     https://docs.stripe.com/api/invoices/object#invoice_object-parent (read 2026-09-29)
//   - card fingerprint: payment_method.card.fingerprint
//     https://docs.stripe.com/api/payment_methods/object#payment_method_object-card-fingerprint
//   - prices by lookup key: GET /v1/prices?lookup_keys[]=…&expand[]=data.product
//     https://docs.stripe.com/api/prices/list (read 2026-09-29)

//   21.5 plan changes (read 2026-10-04):
//   - preview: POST /v1/invoices/create_preview with subscription + subscription_details.items
//     ({id, price, quantity}), proration_behavior and proration_date
//     https://docs.stripe.com/api/invoices/create_preview,
//     https://docs.stripe.com/billing/subscriptions/prorations#preview-proration
//   - change now: subscriptions.update items[{id, price, quantity}] (quantity must be repeated:
//     "Updating a subscription price automatically reverts the quantity to … 1"),
//     proration_behavior=always_invoice + the previewed proration_date,
//     payment_behavior=pending_if_incomplete (applied only once the invoice is paid)
//     https://docs.stripe.com/billing/subscriptions/change-price,
//     https://docs.stripe.com/billing/subscriptions/pending-updates
//   - change at period end: subscription_schedules.create {from_subscription}, then update with
//     the current phase (its start/end, items and settings) + a next phase; end_behavior=release
//     https://docs.stripe.com/billing/subscriptions/subscription-schedules (Schedule an upgrade
//     or downgrade for an existing subscription); release: POST …/release
//   - cancel / resume: subscriptions.update cancel_at_period_end=true|false
//     https://docs.stripe.com/billing/subscriptions/cancel

export type Interval = 'week' | 'month' | 'year';

/** 21.5: the change a subscription schedule will apply when the current period ends. */
export interface PendingPlanChange {
  quantity: number;
  priceId: string | null;
  /** null when the phase's price was not expanded (reconcile re-fetches it). */
  lookupKey: string | null;
  effectiveAt: Date;
}

/** A subscription as Studio stores it (re-fetched from the API on every event). */
export interface SubscriptionState {
  id: string;
  customerId: string;
  status: string;
  lookupKey: string | null;
  priceId: string | null;
  /** 21.5: the (single) subscription item, needed to change its price or quantity. */
  itemId: string | null;
  /** 21.5: an attached subscription schedule (a change waiting for the end of the period). */
  scheduleId: string | null;
  pendingChange: PendingPlanChange | null;
  /** 21.5: an immediate change waiting for its invoice to be paid (pending_update). */
  hasPendingUpdate: boolean;
  /** product.metadata.studio_tier — how ENTERPRISE (no lookup key) subscriptions are mapped. */
  productTier: string | null;
  interval: Interval | null;
  unitAmountPence: number | null;
  quantity: number;
  currency: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
  metadataOrganisationId: string | null;
  defaultPaymentMethodId: string | null;
  created: Date;
}

export interface CheckoutSessionState {
  id: string;
  mode: 'payment' | 'setup' | 'subscription' | string;
  status: string | null;
  paymentStatus: string;
  customerId: string | null;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
}

export interface InvoiceState {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
  hostedInvoiceUrl: string | null;
}

export interface ChargeState {
  id: string;
  paymentIntentId: string | null;
  customerId: string | null;
  amount: number;
  amountRefunded: number;
  refunded: boolean;
}

export interface PriceState {
  id: string;
  lookupKey: string | null;
  unitAmountPence: number | null;
  currency: string;
  interval: Interval | null;
  active: boolean;
  productName: string | null;
  productTier: string | null;
  taxBehavior: string | null;
}

/** 21.5: what `invoices.createPreview` says a change would invoice now. */
export interface PlanChangePreview {
  /** What the customer pays now (after any customer balance), in the invoice currency. */
  amountDuePence: number;
  totalPence: number;
  /** Tax included in `totalPence` (Stripe Tax; 0 when not applicable). */
  taxPence: number;
  currency: string;
  /** The proration time the preview used; pass it to the update so the amounts match. */
  prorationDate: number;
}

export interface PlanItemChange {
  subscriptionId: string;
  itemId: string;
  priceId: string;
  quantity: number;
}

export interface StripeGateway {
  createCustomer(
    input: { organisationId: string; name?: string; email?: string },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<{ id: string; url: string | null }>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionState>;
  createPortalSession(params: {
    customer: string;
    returnUrl: string;
    configuration?: string;
    locale?: Stripe.BillingPortal.SessionCreateParams.Locale;
  }): Promise<{ url: string }>;
  /** null when Stripe no longer knows the subscription (deleted in test mode). */
  retrieveSubscription(id: string): Promise<SubscriptionState | null>;
  listSubscriptions(): AsyncIterable<SubscriptionState>;
  endTrialNow(subscriptionId: string, idempotencyKey: string): Promise<void>;
  cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<void>;
  listInvoices(customerId: string, limit: number): Promise<BillingInvoice[]>;
  retrieveInvoice(id: string): Promise<InvoiceState>;
  listPrices(lookupKeys: readonly string[]): Promise<PriceState[]>;
  paymentMethodFingerprint(paymentMethodId: string): Promise<string | null>;
  customerDefaultPaymentMethod(customerId: string): Promise<string | null>;
  retrieveCharge(id: string): Promise<ChargeState>;
  retrieveEvent(id: string): Promise<Stripe.Event>;
  markCustomerDeleted(customerId: string): Promise<void>;
  /** 21.5: the invoice an immediate change would raise now (always_invoice proration). */
  previewPlanChange(
    change: PlanItemChange & { customerId: string; prorationDate: number },
  ): Promise<PlanChangePreview>;
  /**
   * 21.5: apply a change now. `prorationDate` null = no proration (a trialing subscription:
   * nothing is charged until the trial ends). Returns the subscription as Stripe now has it.
   */
  changePlanNow(
    change: PlanItemChange & { prorationDate: number | null },
    idempotencyKey: string,
  ): Promise<SubscriptionState>;
  /** 21.5: schedule a change for the end of the current period (replacing any earlier one). */
  schedulePlanChange(
    change: PlanItemChange & {
      scheduleId: string | null;
      interval: Interval;
      organisationId: string;
    },
    idempotencyKey: string,
  ): Promise<void>;
  /** 21.5: drop a scheduled change (release the schedule; the subscription stays as it is). */
  releaseSchedule(scheduleId: string, idempotencyKey: string): Promise<void>;
  /** 21.5: cancel at the end of the period (true) or keep the subscription (false). */
  setCancelAtPeriodEnd(
    subscriptionId: string,
    cancel: boolean,
    idempotencyKey: string,
  ): Promise<void>;
}

// ------------------------------------------------------------------ conversion (pure)

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function date(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

function interval(value: string | null | undefined): Interval | null {
  return value === 'week' || value === 'month' || value === 'year' ? value : null;
}

/**
 * 21.5: the next phase of an attached schedule = the change waiting for the end of the period.
 * Only an expanded schedule that is not released or finished counts; its phase that starts when
 * the current phase ends (or the first future phase) holds the new price and quantity.
 */
export function pendingChangeOf(
  schedule: Stripe.Subscription['schedule'],
  now: Date,
): PendingPlanChange | null {
  if (!schedule || typeof schedule === 'string') return null;
  if (schedule.status !== 'active' && schedule.status !== 'not_started') return null;
  const nowSec = Math.floor(now.getTime() / 1000);
  const boundary = schedule.current_phase?.end_date ?? nowSec;
  const next =
    schedule.phases.find((p) => p.start_date === boundary) ??
    schedule.phases.find((p) => p.start_date > nowSec);
  const item = next?.items[0];
  if (!next || !item) return null;
  const price = item.price;
  const lookupKey = typeof price === 'string' || price.deleted ? null : (price.lookup_key ?? null);
  return {
    quantity: item.quantity ?? 1,
    priceId: typeof price === 'string' ? price : price.id,
    lookupKey,
    effectiveAt: new Date(next.start_date * 1000),
  };
}

function productTierOf(product: Stripe.Price['product'] | null | undefined): string | null {
  if (!product || typeof product === 'string' || product.deleted) return null;
  return product.metadata?.studio_tier?.trim().toUpperCase() || null;
}

export function toSubscriptionState(
  sub: Stripe.Subscription,
  now: Date = new Date(),
): SubscriptionState {
  const item = sub.items.data[0];
  const price = item?.price;
  return {
    id: sub.id,
    customerId: idOf(sub.customer) ?? '',
    status: sub.status,
    lookupKey: price?.lookup_key ?? null,
    priceId: price?.id ?? null,
    itemId: item?.id ?? null,
    scheduleId: idOf(sub.schedule),
    pendingChange: pendingChangeOf(sub.schedule, now),
    hasPendingUpdate: Boolean(sub.pending_update),
    productTier: productTierOf(price?.product),
    interval: interval(price?.recurring?.interval),
    unitAmountPence: price?.unit_amount ?? null,
    quantity: item?.quantity ?? 1,
    currency: price?.currency ?? null,
    currentPeriodStart: date(item?.current_period_start),
    currentPeriodEnd: date(item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    trialEnd: date(sub.trial_end),
    metadataOrganisationId: sub.metadata?.organisationId ?? null,
    defaultPaymentMethodId: idOf(sub.default_payment_method),
    created: new Date(sub.created * 1000),
  };
}

export function toCheckoutSessionState(s: Stripe.Checkout.Session): CheckoutSessionState {
  return {
    id: s.id,
    mode: s.mode,
    status: s.status ?? null,
    paymentStatus: s.payment_status,
    customerId: idOf(s.customer),
    subscriptionId: idOf(s.subscription),
    paymentIntentId: idOf(s.payment_intent),
    clientReferenceId: s.client_reference_id,
    metadata: { ...(s.metadata ?? {}) },
  };
}

export function toInvoiceState(inv: Stripe.Invoice): InvoiceState {
  return {
    id: inv.id ?? '',
    customerId: idOf(inv.customer),
    subscriptionId: idOf(inv.parent?.subscription_details?.subscription ?? null),
    status: inv.status ?? null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  };
}

export function toBillingInvoice(inv: Stripe.Invoice): BillingInvoice {
  return {
    id: inv.id ?? '',
    number: inv.number ?? null,
    status: inv.status ?? 'draft',
    amountDuePence: inv.amount_due,
    currency: inv.currency,
    createdAt: new Date(inv.created * 1000).toISOString(),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    invoicePdfUrl: inv.invoice_pdf ?? null,
  };
}

export function toPriceState(price: Stripe.Price): PriceState {
  const product = typeof price.product === 'string' || price.product.deleted ? null : price.product;
  return {
    id: price.id,
    lookupKey: price.lookup_key,
    unitAmountPence: price.unit_amount,
    currency: price.currency,
    interval: interval(price.recurring?.interval),
    active: price.active,
    productName: product?.name ?? null,
    productTier: productTierOf(price.product),
    taxBehavior: price.tax_behavior ?? null,
  };
}

export function toPlanChangePreview(inv: Stripe.Invoice, prorationDate: number): PlanChangePreview {
  return {
    amountDuePence: inv.amount_due,
    totalPence: inv.total,
    taxPence: (inv.total_taxes ?? []).reduce((sum, t) => sum + t.amount, 0),
    currency: inv.currency,
    prorationDate,
  };
}

/** The params of an immediate change (pending_if_incomplete: applied once the invoice is paid). */
export function changeNowParams(
  change: PlanItemChange & { prorationDate: number | null },
): Stripe.SubscriptionUpdateParams {
  const items = [{ id: change.itemId, price: change.priceId, quantity: change.quantity }];
  if (change.prorationDate === null) return { items, proration_behavior: 'none' };
  return {
    items,
    proration_behavior: 'always_invoice',
    proration_date: change.prorationDate,
    payment_behavior: 'pending_if_incomplete',
  };
}

type SchedulePhase = Stripe.SubscriptionSchedule.Phase;

/** The settings a phase must repeat (Stripe unsets omitted parameters on a schedule update). */
function phaseSettings(phase: SchedulePhase, organisationId: string) {
  const paymentMethod = idOf(phase.default_payment_method);
  return {
    ...(phase.automatic_tax && { automatic_tax: { enabled: phase.automatic_tax.enabled } }),
    ...(paymentMethod && { default_payment_method: paymentMethod }),
    metadata: { ...(phase.metadata ?? {}), organisationId },
  };
}

/**
 * The schedule update that keeps the current phase as it is (dates, items, tax, payment method,
 * trial) and adds one phase with the new price and quantity, starting when the current period
 * ends; end_behavior=release hands the subscription back afterwards.
 */
export function schedulePhasesParams(
  schedule: Pick<Stripe.SubscriptionSchedule, 'phases' | 'current_phase'>,
  next: { priceId: string; quantity: number; interval: Interval },
  organisationId: string,
): Stripe.SubscriptionScheduleUpdateParams {
  const current =
    schedule.phases.find((p) => p.start_date === schedule.current_phase?.start_date) ??
    schedule.phases[0];
  if (!current) throw new UpstreamServiceError('Stripe schedule has no current phase');
  const settings = phaseSettings(current, organisationId);
  return {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      {
        items: current.items.map((item) => ({
          price: idOf(item.price) ?? '',
          quantity: item.quantity ?? 1,
        })),
        start_date: current.start_date,
        end_date: current.end_date,
        ...(current.trial_end && { trial_end: current.trial_end }),
        ...settings,
      },
      {
        items: [{ price: next.priceId, quantity: next.quantity }],
        duration: { interval: next.interval, interval_count: 1 },
        ...settings,
      },
    ],
  };
}

// ------------------------------------------------------------------ the real adapter

function upstream(action: string, err: unknown): UpstreamServiceError {
  const e = err as { type?: string; code?: string; statusCode?: number; requestId?: string };
  return new UpstreamServiceError(`Stripe ${action} failed`, {
    provider: 'stripe',
    type: e.type ?? null,
    code: e.code ?? null,
    status: e.statusCode ?? null,
    requestId: e.requestId ?? null,
  });
}

async function call<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw upstream(action, err);
  }
}

function isMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number };
  return e.code === 'resource_missing' || e.statusCode === 404;
}

/** 21.5: the schedule's phase prices too, so a pending change carries its lookup key. */
const SUBSCRIPTION_EXPAND = ['items.data.price.product', 'schedule.phases.items.price'];
const LIST_PAGE = 100;
/** prices.list for the public pricing page (see listPrices). */
const PRICES_TIMEOUT_MS = 4_000;

export function createStripeGateway(stripe: Stripe): StripeGateway {
  return {
    createCustomer: (input, idempotencyKey) =>
      call('customers.create', async () => {
        const customer = await stripe.customers.create(
          {
            name: input.name,
            email: input.email,
            metadata: { organisationId: input.organisationId },
          },
          { idempotencyKey },
        );
        return { id: customer.id };
      }),
    createCheckoutSession: (params, idempotencyKey) =>
      call('checkout.sessions.create', async () => {
        const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
        return { id: session.id, url: session.url ?? null };
      }),
    retrieveCheckoutSession: (id) =>
      call('checkout.sessions.retrieve', async () =>
        toCheckoutSessionState(await stripe.checkout.sessions.retrieve(id)),
      ),
    createPortalSession: (params) =>
      call('billing_portal.sessions.create', async () => {
        const session = await stripe.billingPortal.sessions.create({
          customer: params.customer,
          return_url: params.returnUrl,
          ...(params.configuration && { configuration: params.configuration }),
          ...(params.locale && { locale: params.locale }),
        });
        return { url: session.url };
      }),
    retrieveSubscription: async (id) => {
      try {
        return toSubscriptionState(
          await stripe.subscriptions.retrieve(id, { expand: SUBSCRIPTION_EXPAND }),
        );
      } catch (err) {
        if (isMissing(err)) return null;
        throw upstream('subscriptions.retrieve', err);
      }
    },
    async *listSubscriptions() {
      // Stripe expands at most 4 levels, and a list's own `data.` counts as one, so
      // `data.items.data.price.product` (5) is refused ("property_expansion_max_depth", seen on
      // the 21.5 migration, 2026-10-05; https://docs.stripe.com/expand, read 2026-10-05). List the
      // ids, then retrieve each with the same expansion as a single read (4 levels).
      try {
        for await (const sub of stripe.subscriptions.list({ status: 'all', limit: LIST_PAGE })) {
          yield toSubscriptionState(
            await stripe.subscriptions.retrieve(sub.id, { expand: SUBSCRIPTION_EXPAND }),
          );
        }
      } catch (err) {
        throw upstream('subscriptions.list', err);
      }
    },
    endTrialNow: (subscriptionId, idempotencyKey) =>
      call('subscriptions.update', async () => {
        await stripe.subscriptions.update(subscriptionId, { trial_end: 'now' }, { idempotencyKey });
      }),
    cancelSubscription: (subscriptionId, idempotencyKey) =>
      call('subscriptions.cancel', async () => {
        await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey });
      }),
    listInvoices: (customerId, limit) =>
      call('invoices.list', async () => {
        const page = await stripe.invoices.list({ customer: customerId, limit });
        return page.data.map(toBillingInvoice);
      }),
    retrieveInvoice: (id) =>
      call('invoices.retrieve', async () => toInvoiceState(await stripe.invoices.retrieve(id))),
    listPrices: (lookupKeys) =>
      call('prices.list', async () => {
        // The public /pricing page renders from this: a short timeout and no retries, so a slow or
        // unreachable Stripe shows the page without amounts (retried a minute later) instead of
        // holding it for the client default (20 s x 3 attempts). Per-request RequestOptions,
        // stripe-node 22.6.2 lib.d.ts (timeout, maxNetworkRetries).
        // More lookup keys than Stripe's 10-per-request limit: batched (stripe-lookup.ts).
        const prices = await listPricesByLookupKeys(
          stripe.prices,
          lookupKeys,
          { active: true, limit: LIST_PAGE, expand: ['data.product'] },
          { timeout: PRICES_TIMEOUT_MS, maxNetworkRetries: 0 },
        );
        return prices.map(toPriceState);
      }),
    paymentMethodFingerprint: (paymentMethodId) =>
      call('payment_methods.retrieve', async () => {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        return pm.card?.fingerprint ?? null;
      }),
    customerDefaultPaymentMethod: (customerId) =>
      call('customers.retrieve', async () => {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return null;
        return idOf(customer.invoice_settings?.default_payment_method ?? null);
      }),
    retrieveCharge: (id) =>
      call('charges.retrieve', async () => {
        const charge = await stripe.charges.retrieve(id);
        return {
          id: charge.id,
          paymentIntentId: idOf(charge.payment_intent),
          customerId: idOf(charge.customer),
          amount: charge.amount,
          amountRefunded: charge.amount_refunded,
          refunded: charge.refunded,
        };
      }),
    retrieveEvent: (id) => call('events.retrieve', () => stripe.events.retrieve(id)),
    markCustomerDeleted: (customerId) =>
      call('customers.update', async () => {
        await stripe.customers.update(customerId, { metadata: { studio_deleted: 'true' } });
      }),
    previewPlanChange: (change) =>
      call('invoices.createPreview', async () =>
        toPlanChangePreview(
          await stripe.invoices.createPreview({
            customer: change.customerId,
            subscription: change.subscriptionId,
            subscription_details: {
              items: [{ id: change.itemId, price: change.priceId, quantity: change.quantity }],
              proration_behavior: 'always_invoice',
              proration_date: change.prorationDate,
            },
          }),
          change.prorationDate,
        ),
      ),
    changePlanNow: (change, idempotencyKey) =>
      call('subscriptions.update', async () =>
        toSubscriptionState(
          await stripe.subscriptions.update(
            change.subscriptionId,
            { ...changeNowParams(change), expand: SUBSCRIPTION_EXPAND },
            { idempotencyKey },
          ),
        ),
      ),
    schedulePlanChange: (change, idempotencyKey) =>
      call('subscription_schedules.update', async () => {
        // One pending change at a time: an earlier schedule is released first, so the new
        // schedule starts from the subscription exactly as it is now.
        if (change.scheduleId)
          await stripe.subscriptionSchedules.release(
            change.scheduleId,
            {},
            {
              idempotencyKey: `${idempotencyKey}:release`,
            },
          );
        const schedule = await stripe.subscriptionSchedules.create(
          { from_subscription: change.subscriptionId },
          { idempotencyKey: `${idempotencyKey}:create` },
        );
        await stripe.subscriptionSchedules.update(
          schedule.id,
          schedulePhasesParams(
            schedule,
            { priceId: change.priceId, quantity: change.quantity, interval: change.interval },
            change.organisationId,
          ),
          { idempotencyKey: `${idempotencyKey}:update` },
        );
      }),
    releaseSchedule: (scheduleId, idempotencyKey) =>
      call('subscription_schedules.release', async () => {
        await stripe.subscriptionSchedules.release(scheduleId, {}, { idempotencyKey });
      }),
    setCancelAtPeriodEnd: (subscriptionId, cancel, idempotencyKey) =>
      call('subscriptions.update', async () => {
        await stripe.subscriptions.update(
          subscriptionId,
          { cancel_at_period_end: cancel },
          { idempotencyKey },
        );
      }),
  };
}
