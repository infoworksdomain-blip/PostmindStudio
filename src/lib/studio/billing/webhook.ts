import type Stripe from 'stripe';
import { AuditAction } from '../../audit-sink';
import { ValidationError } from '../../errors';
import { creditTopUp, refundTopUpCredits } from './credits';
import type { StripeGateway } from './gateway';
import { planDisplayName, topUpPackName } from './email-params';
import { rotateCheckoutNonce } from './service';
import {
  emailOwners,
  markPaid,
  organisationForCustomer,
  recomputeEntitlements,
  startGrace,
  STRIPE_ACTOR,
  syncSubscription,
  type BillingSyncDeps,
} from './sync';
import { enforceTrialRules } from './trial';
import { invalidateEntitlements } from './entitlements-reader';

// Phase 18 §2.7 / §5.7 — POST /api/billing/stripe/webhook.
// Docs read 2026-09-29: https://docs.stripe.com/webhooks (signatures on the raw body, 300 s
// default tolerance, duplicate deliveries, no ordering guarantee, reply 2xx quickly, live-mode
// retries for up to three days) and https://docs.stripe.com/billing/subscriptions/webhooks.
//
//   1. verify: stripe.webhooks.constructEvent(raw, Stripe-Signature, STRIPE_WEBHOOK_SECRET) with
//      the SDK's default 300 s tolerance. A bad signature is a 400, logged without the body.
//   2. dedupe: INSERT stripe_events(id) … ON CONFLICT DO NOTHING; an already PROCESSED id is
//      acknowledged and skipped; one that failed earlier (processedAt null) is retried.
//   3. process: subscription and invoice events RE-FETCH the subscription from the API and store
//      its current state, so payload order never matters. Nothing from metadata is trusted
//      without the billing_customers match (sync.ts).
//   4. failures leave processedAt null (lastError, attempts) and the sweeper (reconcile.ts)
//      re-processes them; the route still answers 2xx once the event is recorded, so Stripe does
//      not retry-storm us while our own sweeper owns the retry.

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'customer.updated',
  'charge.refunded',
  'charge.dispute.created',
] as const;

const HANDLED = new Set<string>(HANDLED_EVENTS);
const MAX_ERROR = 500;

export interface WebhookDeps extends BillingSyncDeps {
  gateway: StripeGateway;
  /** Verifies the signature (stripe.webhooks.constructEvent); throws on a bad signature. */
  constructEvent: (raw: string, signature: string) => Stripe.Event;
  /** Staff alerts (charge.dispute.created). */
  notifyStaff?: (input: { title: string; body: string; link?: string }) => Promise<unknown>;
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'failed';

function objectId(event: Stripe.Event): string | null {
  const obj = event.data.object as { id?: unknown };
  return typeof obj.id === 'string' ? obj.id : null;
}

/** Verify, dedupe and process one delivery. A missing or bad signature is a 400. */
export async function receiveStripeWebhook(
  deps: WebhookDeps,
  raw: string,
  signature: string | null,
): Promise<{ outcome: WebhookOutcome; eventId: string; type: string }> {
  if (!signature) throw new ValidationError('Missing Stripe-Signature header');
  let event: Stripe.Event;
  try {
    event = deps.constructEvent(raw, signature);
  } catch {
    // Never log the body or the header: they may carry customer data.
    throw new ValidationError('Invalid Stripe signature');
  }
  const inserted = await deps.db.$executeRaw`
    INSERT INTO "studio"."stripe_events" ("id", "type", "objectId", "receivedAt", "attempts")
    VALUES (${event.id}, ${event.type}, ${objectId(event)}, ${new Date(deps.now())}, 0)
    ON CONFLICT ("id") DO NOTHING`;
  if (inserted === 0) {
    const row = await deps.db.stripeEvent.findUnique({ where: { id: event.id } });
    if (row?.processedAt) return { outcome: 'duplicate', eventId: event.id, type: event.type };
  }
  const outcome = await processRecordedEvent(deps, event);
  return { outcome, eventId: event.id, type: event.type };
}

/** Process an event already recorded in stripe_events; records success or the error. */
export async function processRecordedEvent(
  deps: WebhookDeps,
  event: Stripe.Event,
): Promise<WebhookOutcome> {
  try {
    const handled = HANDLED.has(event.type);
    if (handled) await processStripeEvent(deps, event);
    await deps.db.stripeEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(deps.now()),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    return handled ? 'processed' : 'ignored';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.error(
      { err, eventId: event.id, type: event.type },
      'stripe event failed; the sweeper retries it',
    );
    await deps.db.stripeEvent
      .update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, lastError: message.slice(0, MAX_ERROR) },
      })
      .catch((updateErr: unknown) =>
        deps.logger.error({ err: updateErr, eventId: event.id }, 'could not record event error'),
      );
    return 'failed';
  }
}

async function syncById(deps: WebhookDeps, subscriptionId: string | null, cause: string) {
  if (!subscriptionId) return null;
  const state = await deps.gateway.retrieveSubscription(subscriptionId);
  if (!state) {
    // Deleted in Stripe (test mode clean-up): keep our row, mark it cancelled.
    const row = await deps.db.subscription.findUnique({ where: { id: subscriptionId } });
    if (!row) return null;
    await deps.db.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'canceled', stripeUpdatedAt: new Date(deps.now()) },
    });
    return recomputeEntitlements(deps, row.organisationId, cause);
  }
  const result = await syncSubscription(deps, state, cause);
  if (result) await enforceTrialRules(deps, state, result.organisationId);
  return result;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
    return (value as { id: string }).id;
  return null;
}

async function invoiceContext(deps: WebhookDeps, invoiceId: string) {
  const invoice = await deps.gateway.retrieveInvoice(invoiceId);
  const organisationId = await organisationForCustomer(deps.db, invoice.customerId);
  return { invoice, organisationId };
}

async function handleCheckout(deps: WebhookDeps, sessionId: string, cause: string) {
  const session = await deps.gateway.retrieveCheckoutSession(sessionId);
  const organisationId = await organisationForCustomer(deps.db, session.customerId);
  if (!organisationId) {
    deps.logger.warn({ sessionId, cause }, 'checkout session for an unknown customer; ignored');
    return;
  }
  if (session.clientReferenceId && session.clientReferenceId !== organisationId) {
    deps.logger.warn({ sessionId, organisationId }, 'checkout client_reference_id mismatch');
  }
  if (session.mode === 'subscription') {
    await syncById(deps, session.subscriptionId, cause);
    await rotateCheckoutNonce(deps.db, organisationId);
    return;
  }
  if (session.mode !== 'payment') return;
  const now = new Date(deps.now());
  const outcome = await creditTopUp(deps.db, session, organisationId, now);
  if (outcome.status === 'credited') {
    invalidateEntitlements(organisationId);
    await rotateCheckoutNonce(deps.db, organisationId);
    deps.audit({
      actorUserId: STRIPE_ACTOR,
      organisationId,
      action: AuditAction.BillingTopupPurchased,
      resource: { type: 'usage_credit', id: outcome.creditId },
      metadata: { pack: outcome.pack.lookupKey, quantity: outcome.pack.quantity, sessionId },
    });
    await emailOwners(
      deps,
      organisationId,
      'topupReceipt',
      async (locale) => ({ packName: await topUpPackName(outcome.pack, locale) }),
      `billing:topup:${session.id}`,
    );
  } else if (outcome.status === 'unknown_pack') {
    deps.logger.warn({ sessionId }, 'paid checkout session without a known top-up pack');
  }
}

/** Billing settings on APP_URL (a link for emails that have no Stripe page). */
function billingSettingsUrl(): string {
  return new URL('/settings/billing', process.env.APP_URL ?? 'http://localhost:3010').toString();
}

/** The event → action table. Only called for HANDLED_EVENTS. */
export async function processStripeEvent(deps: WebhookDeps, event: Stripe.Event): Promise<void> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const id = objectId(event);
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (id) await handleCheckout(deps, id, event.type);
      return;
    case 'checkout.session.async_payment_failed': {
      const organisationId = await organisationForCustomer(deps.db, idOf(obj.customer));
      if (organisationId)
        deps.audit({
          actorUserId: STRIPE_ACTOR,
          organisationId,
          action: AuditAction.BillingPaymentFailed,
          resource: { type: 'checkout_session', id: id ?? '' },
          metadata: { cause: event.type },
        });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const result = await syncById(deps, id, event.type);
      if (result && event.type === 'customer.subscription.deleted') {
        // Access runs to the end of the paid period; a subscription deleted outright ends now.
        const row = await deps.db.subscription.findUnique({ where: { id: id ?? '' } });
        const periodEnd = row?.currentPeriodEnd?.getTime() ?? 0;
        const endsAt = new Date(Math.max(periodEnd, deps.now()));
        await emailOwners(
          deps,
          result.organisationId,
          'subscriptionCanceled',
          { endsAt: endsAt.toISOString() },
          `billing:canceled:${id}`,
        );
      }
      return;
    }
    case 'customer.subscription.trial_will_end': {
      const result = await syncById(deps, id, event.type);
      if (result) {
        const row = await deps.db.subscription.findUnique({ where: { id: id ?? '' } });
        const planName = planDisplayName(row?.productTier ?? row?.lookupKey);
        if (row?.trialEnd && planName)
          await emailOwners(
            deps,
            result.organisationId,
            'trialEnding',
            { planName, trialEndsAt: row.trialEnd.toISOString() },
            `billing:trial-ending:${id}`,
          );
        else
          deps.logger.warn(
            { subscriptionId: id },
            'trial ending email skipped: the subscription has no trial end or plan',
          );
      }
      return;
    }
    case 'invoice.paid': {
      if (!id) return;
      const { invoice, organisationId } = await invoiceContext(deps, id);
      if (!organisationId) return;
      await markPaid(deps, organisationId);
      if (invoice.subscriptionId) await syncById(deps, invoice.subscriptionId, event.type);
      else await recomputeEntitlements(deps, organisationId, event.type);
      return;
    }
    case 'invoice.payment_failed': {
      if (!id) return;
      const { invoice, organisationId } = await invoiceContext(deps, id);
      if (!organisationId) return;
      const graceUntil = await startGrace(deps, organisationId);
      if (invoice.subscriptionId) await syncById(deps, invoice.subscriptionId, event.type);
      deps.audit({
        actorUserId: STRIPE_ACTOR,
        organisationId,
        action: AuditAction.BillingPaymentFailed,
        resource: { type: 'invoice', id },
        metadata: { graceUntil: graceUntil.toISOString() },
      });
      await emailOwners(
        deps,
        organisationId,
        'paymentFailed',
        { graceEndsAt: graceUntil.toISOString(), url: invoice.hostedInvoiceUrl },
        `billing:payment-failed:${id}`,
      );
      return;
    }
    case 'invoice.payment_action_required': {
      if (!id) return;
      const { invoice, organisationId } = await invoiceContext(deps, id);
      if (!organisationId) return;
      await emailOwners(
        deps,
        organisationId,
        'paymentActionRequired',
        // Stripe's hosted page confirms the payment (3-D Secure); without one, billing settings.
        { url: invoice.hostedInvoiceUrl ?? billingSettingsUrl() },
        `billing:action-required:${id}`,
      );
      return;
    }
    case 'customer.updated': {
      // Tax id and address live in Stripe (Checkout collects them); nothing is copied locally.
      const organisationId = await organisationForCustomer(deps.db, id);
      if (organisationId) deps.logger.info({ organisationId }, 'stripe customer updated');
      return;
    }
    case 'charge.refunded': {
      if (!id) return;
      const charge = await deps.gateway.retrieveCharge(id);
      const result = await refundTopUpCredits(deps.db, charge, new Date(deps.now()));
      if (result) {
        const organisationId = await organisationForCustomer(deps.db, charge.customerId);
        if (organisationId) invalidateEntitlements(organisationId);
        deps.audit({
          actorUserId: STRIPE_ACTOR,
          organisationId: organisationId ?? 'unknown',
          action: 'billing.topup_refunded',
          resource: { type: 'usage_credit', id: result.creditId },
          metadata: { removed: result.removed, chargeId: id },
        });
      }
      return;
    }
    case 'charge.dispute.created': {
      const chargeId = idOf(obj.charge);
      const charge = chargeId ? await deps.gateway.retrieveCharge(chargeId) : null;
      const organisationId = charge
        ? await organisationForCustomer(deps.db, charge.customerId)
        : null;
      deps.audit({
        actorUserId: STRIPE_ACTOR,
        organisationId: organisationId ?? 'postmind-platform',
        action: 'billing.dispute_created',
        resource: { type: 'dispute', id: id ?? '' },
        metadata: { chargeId },
      });
      deps.logger.warn({ disputeId: id, organisationId }, 'stripe dispute opened');
      await deps.notifyStaff?.({
        title: 'Stripe dispute opened',
        body: `A customer disputed a charge (${id ?? 'unknown'}${organisationId ? `, organisation ${organisationId}` : ''}). Respond in the Stripe dashboard.`,
        link: '/admin',
      });
      return;
    }
    default:
      return;
  }
}
