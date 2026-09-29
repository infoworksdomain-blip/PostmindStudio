import type Stripe from 'stripe';
import { UpstreamServiceError } from '../../errors';
import type { BillingInvoice } from './contracts';

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

export type Interval = 'month' | 'year';

/** A subscription as Studio stores it (re-fetched from the API on every event). */
export interface SubscriptionState {
  id: string;
  customerId: string;
  status: string;
  lookupKey: string | null;
  priceId: string | null;
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
  return value === 'month' || value === 'year' ? value : null;
}

function productTierOf(product: Stripe.Price['product'] | null | undefined): string | null {
  if (!product || typeof product === 'string' || product.deleted) return null;
  return product.metadata?.studio_tier?.trim().toUpperCase() || null;
}

export function toSubscriptionState(sub: Stripe.Subscription): SubscriptionState {
  const item = sub.items.data[0];
  const price = item?.price;
  return {
    id: sub.id,
    customerId: idOf(sub.customer) ?? '',
    status: sub.status,
    lookupKey: price?.lookup_key ?? null,
    priceId: price?.id ?? null,
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

const SUBSCRIPTION_EXPAND = ['items.data.price.product'];
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
      try {
        for await (const sub of stripe.subscriptions.list({
          status: 'all',
          limit: LIST_PAGE,
          expand: ['data.items.data.price.product'],
        })) {
          yield toSubscriptionState(sub);
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
        const page = await stripe.prices.list(
          {
            lookup_keys: [...lookupKeys],
            active: true,
            limit: LIST_PAGE,
            expand: ['data.product'],
          },
          { timeout: PRICES_TIMEOUT_MS, maxNetworkRetries: 0 },
        );
        return page.data.map(toPriceState);
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
  };
}
