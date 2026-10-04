import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { AuditAction } from '../../audit-sink';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { PLAN_CATALOGUE, sellableTopUpPack } from './catalogue';
import { assertChannelCount, CHANNEL_LOOKUP_KEYS, CHANNEL_PLAN_TIER } from './channel-plan';
import type { BillingInvoice, BillingService, CheckoutRequest } from './contracts';
import { trialDays } from './entitlements';
import type { StripeGateway } from './gateway';
import {
  cancelPlan,
  cancelScheduledChange,
  changePlan,
  previewPlanChange,
  resumePlan,
} from './plan-change';
import { governingSubscription } from './sync';

// Phase 18 §2.7 — Checkout, Customer Portal, invoices and cancellation for deletion.
// Docs read 2026-09-29:
//   Checkout Sessions create  https://docs.stripe.com/api/checkout/sessions/create
//   Subscriptions + trials    https://docs.stripe.com/billing/subscriptions/trials
//   Stripe Tax in Checkout    https://docs.stripe.com/tax/checkout
//   Idempotent requests       https://docs.stripe.com/api/idempotent_requests
//   Customer Portal sessions  https://docs.stripe.com/api/customer_portal/sessions/create
//
// Idempotency-Key = sha256(orgId, intent, nonce): the nonce lives in billing_customers and is
// rotated after each completed checkout, so a double-clicked "Subscribe" (same nonce) returns the
// same Checkout session, while a later, deliberate new checkout gets a new one. Stripe keeps keys
// for 24 hours.

type Env = Record<string, string | undefined>;

export interface BillingServiceDeps {
  db: PrismaClient;
  gateway: StripeGateway;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  now: () => number;
  appUrl: string;
  env?: Env;
}

export const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

export function idempotencyKey(organisationId: string, intent: string, nonce: string): string {
  const digest = createHash('sha256').update(`${organisationId}|${intent}|${nonce}`).digest('hex');
  return `studio-${intent.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40)}-${digest.slice(0, 40)}`;
}

function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Studio locale → Stripe Checkout / portal locale ('auto' where Stripe has no match). */
export function stripeLocale(locale: string): Stripe.Checkout.SessionCreateParams.Locale {
  const map: Record<string, Stripe.Checkout.SessionCreateParams.Locale> = {
    'en-GB': 'en-GB',
    'en-US': 'en',
    fr: 'fr',
    es: 'es',
    de: 'de',
    it: 'it',
    'pt-BR': 'pt-BR',
    'pt-PT': 'pt',
    'zh-Hans': 'zh',
  };
  return map[locale] ?? 'auto';
}

/** Only relative in-app paths may be used as return targets (no open redirect, §5.9). */
export function safeReturnPath(path: string | undefined, fallback: string): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
    return fallback;
  return path.slice(0, 200);
}

function appLink(appUrl: string, path: string): string {
  return new URL(path, appUrl).toString();
}

export async function ensureCustomer(
  deps: BillingServiceDeps,
  organisationId: string,
  profile: { name?: string; email?: string },
): Promise<{ stripeCustomerId: string; nonce: string }> {
  const existing = await deps.db.billingCustomer.findUnique({ where: { organisationId } });
  if (existing && !existing.deletedAt)
    return { stripeCustomerId: existing.stripeCustomerId, nonce: existing.idempotencyNonce };
  if (existing?.deletedAt) throw new ConflictError('This organisation is being deleted');
  // Deterministic per organisation: two racing first checkouts create one Stripe customer.
  const customer = await deps.gateway.createCustomer(
    { organisationId, ...profile },
    idempotencyKey(organisationId, 'customer', 'v1'),
  );
  const nonce = newNonce();
  const row = await deps.db.billingCustomer.upsert({
    where: { organisationId },
    create: { organisationId, stripeCustomerId: customer.id, idempotencyNonce: nonce },
    update: {},
  });
  return { stripeCustomerId: row.stripeCustomerId, nonce: row.idempotencyNonce };
}

async function organisationProfile(db: PrismaClient, organisationId: string, userId: string) {
  const [org, user] = await Promise.all([
    db.organization.findUnique({ where: { id: organisationId }, select: { name: true } }),
    db.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  return { name: org?.name ?? undefined, email: user?.email ?? undefined };
}

/** True when the organisation may start a trial: never trialled, no earlier subscription. */
export async function trialEligible(
  db: Pick<PrismaClient, 'orgEntitlement' | 'subscription'>,
  organisationId: string,
): Promise<boolean> {
  const [ent, earlier] = await Promise.all([
    db.orgEntitlement.findUnique({
      where: { organisationId },
      select: { trialStartedAt: true, everPaidAt: true },
    }),
    db.subscription.count({ where: { organisationId } }),
  ]);
  return !ent?.trialStartedAt && !ent?.everPaidAt && earlier === 0;
}

export function checkoutParams(input: {
  request: CheckoutRequest;
  customer: string;
  priceLookup: { priceId: string };
  trialPeriodDays: number | null;
  appUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  const { request } = input;
  // 21.5: the subscription's one item has quantity = channels; a pack is bought once.
  const quantity = request.intent.kind === 'channels' ? request.intent.channels : 1;
  const common = {
    customer: input.customer,
    client_reference_id: request.organisationId,
    locale: stripeLocale(request.locale),
    line_items: [{ price: input.priceLookup.priceId, quantity }],
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required' as const,
    customer_update: { address: 'auto' as const, name: 'auto' as const },
    metadata: { organisationId: request.organisationId, userId: request.userId },
  };
  if (request.intent.kind === 'topup') {
    return {
      ...common,
      mode: 'payment',
      metadata: { ...common.metadata, studio_topup: request.intent.lookupKey },
      payment_intent_data: {
        metadata: {
          organisationId: request.organisationId,
          studio_topup: request.intent.lookupKey,
        },
      },
      invoice_creation: { enabled: true },
      success_url: appLink(input.appUrl, '/settings/billing?topup=success'),
      cancel_url: appLink(input.appUrl, '/settings/billing?topup=cancelled'),
    };
  }
  return {
    ...common,
    mode: 'subscription',
    payment_method_collection: 'always',
    subscription_data: {
      metadata: { organisationId: request.organisationId },
      ...(input.trialPeriodDays && { trial_period_days: input.trialPeriodDays }),
    },
    success_url: appLink(input.appUrl, '/settings/billing?checkout=success'),
    cancel_url: appLink(input.appUrl, '/settings/billing?checkout=cancelled'),
  };
}

async function priceIdFor(gateway: StripeGateway, lookupKey: string): Promise<string> {
  const [price] = (await gateway.listPrices([lookupKey])).filter((p) => p.active);
  if (!price) throw new NotFoundError(`No active Stripe price has the lookup key ${lookupKey}`);
  return price.id;
}

export function createBillingService(deps: BillingServiceDeps): BillingService {
  return {
    async createCheckout(request) {
      let lookupKey: string;
      let intentLabel: string;
      let trialPeriodDays: number | null = null;
      if (request.intent.kind === 'channels') {
        assertChannelCount(request.intent.channels);
        const key = CHANNEL_LOOKUP_KEYS[request.intent.interval];
        if (!key) throw new ValidationError('That billing period cannot be bought online');
        const current = governingSubscription(
          await deps.db.subscription.findMany({
            where: { organisationId: request.organisationId },
          }),
        );
        if (current && ACTIVE_STATUSES.has(current.status)) {
          throw new ConflictError(
            'This organisation already has a subscription; change it on Your plan',
            { subscriptionStatus: current.status },
          );
        }
        lookupKey = key;
        intentLabel = `sub_${key}_${request.intent.channels}`;
        const planTrial = PLAN_CATALOGUE[CHANNEL_PLAN_TIER].trialDays > 0;
        const days = trialDays(deps.env);
        if (planTrial && days > 0 && (await trialEligible(deps.db, request.organisationId)))
          trialPeriodDays = days;
      } else {
        const pack = sellableTopUpPack(request.intent.lookupKey);
        if (!pack) throw new ValidationError('Unknown top-up pack');
        lookupKey = pack.lookupKey;
        intentLabel = `topup_${pack.lookupKey}`;
      }
      const profile = await organisationProfile(deps.db, request.organisationId, request.userId);
      const { stripeCustomerId, nonce } = await ensureCustomer(
        deps,
        request.organisationId,
        profile,
      );
      const params = checkoutParams({
        request,
        customer: stripeCustomerId,
        priceLookup: { priceId: await priceIdFor(deps.gateway, lookupKey) },
        trialPeriodDays,
        appUrl: deps.appUrl,
      });
      const session = await deps.gateway.createCheckoutSession(
        params,
        idempotencyKey(request.organisationId, intentLabel, nonce),
      );
      if (!session.url) throw new ConflictError('Stripe did not return a Checkout URL');
      deps.audit({
        actorUserId: request.userId,
        organisationId: request.organisationId,
        action: AuditAction.BillingCheckoutStarted,
        resource: { type: 'checkout_session', id: session.id },
        metadata: {
          lookupKey,
          trialPeriodDays,
          ...(request.intent.kind === 'channels' && { channels: request.intent.channels }),
        },
      });
      return { url: session.url };
    },

    async createPortal(organisationId, returnPath) {
      const customer = await deps.db.billingCustomer.findUnique({ where: { organisationId } });
      if (!customer || customer.deletedAt)
        throw new NotFoundError(
          'This organisation has no billing account yet; choose a plan first',
        );
      const configuration = deps.env?.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || undefined;
      return deps.gateway.createPortalSession({
        customer: customer.stripeCustomerId,
        returnUrl: appLink(deps.appUrl, safeReturnPath(returnPath, '/settings/billing')),
        configuration,
      });
    },

    async listInvoices(organisationId, limit): Promise<BillingInvoice[]> {
      const customer = await deps.db.billingCustomer.findUnique({ where: { organisationId } });
      if (!customer) return [];
      return deps.gateway.listInvoices(customer.stripeCustomerId, Math.min(Math.max(limit, 1), 50));
    },

    async cancelForDeletion(organisationId) {
      const rows = await deps.db.subscription.findMany({
        where: { organisationId, status: { in: [...ACTIVE_STATUSES, 'incomplete'] } },
      });
      for (const row of rows) {
        await deps.gateway.cancelSubscription(row.id, `studio:cancel-deletion:${row.id}`);
      }
      const customer = await deps.db.billingCustomer.findUnique({ where: { organisationId } });
      if (customer && !customer.deletedAt) {
        await deps.gateway.markCustomerDeleted(customer.stripeCustomerId);
        await deps.db.billingCustomer.update({
          where: { organisationId },
          data: { deletedAt: new Date(deps.now()) },
        });
      }
      deps.audit({
        actorUserId: 'system:studio-billing',
        organisationId,
        action: AuditAction.BillingSubscriptionChanged,
        resource: { type: 'organisation', id: organisationId },
        metadata: { change: 'cancelled_for_deletion', subscriptions: rows.map((r) => r.id) },
      });
    },

    // 21.5 Your plan (billing/plan-change.ts).
    previewPlanChange: (organisationId, next) => previewPlanChange(deps, organisationId, next),
    changePlan: (input) => changePlan(deps, input),
    cancelPlan: (input) => cancelPlan(deps, input),
    resumePlan: (input) => resumePlan(deps, input),
    cancelScheduledChange: (input) => cancelScheduledChange(deps, input),
  };
}

/** After a completed checkout: a new nonce, so the next deliberate checkout is a new session. */
export async function rotateCheckoutNonce(
  db: Pick<PrismaClient, 'billingCustomer'>,
  organisationId: string,
): Promise<void> {
  await db.billingCustomer.updateMany({
    where: { organisationId },
    data: { idempotencyNonce: newNonce() },
  });
}
