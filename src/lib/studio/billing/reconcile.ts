import { recomputeEntitlements, syncSubscription } from './sync';
import { processRecordedEvent, type WebhookDeps } from './webhook';

// Phase 18 §8 "Webhook loss": two safety nets for the Stripe webhook.
//
//   sweepStripeEvents (every 10 minutes): events recorded but not processed (processedAt NULL —
//     the handler threw, or the process died mid-way) are re-fetched from the API
//     (GET /v1/events/:id, https://docs.stripe.com/api/events/retrieve, read 2026-09-29) and
//     processed again; after MAX_EVENT_ATTEMPTS they are left for a person (lastError says why).
//   reconcileSubscriptions (nightly, 03:15 UTC): every subscription Stripe has
//     (subscriptions.list status=all, auto-paginated) is stored again, so a webhook Stripe gave up
//     on (live mode retries for three days) is still applied; then every organisation's
//     entitlements are recomputed so a grace period that ended overnight is stored too.

export const STRIPE_SWEEP_SCHEDULE = '*/10 * * * *';
export const SUBSCRIPTION_RECONCILE_SCHEDULE = '15 3 * * *';
export const MAX_EVENT_ATTEMPTS = 8;
/** Leave the freshest events to the live request that is still processing them. */
const SWEEP_MIN_AGE_MS = 2 * 60_000;
const SWEEP_BATCH = 100;

export interface SweepResult {
  retried: number;
  processed: number;
  failed: number;
}

export async function sweepStripeEvents(deps: WebhookDeps): Promise<SweepResult> {
  const cutoff = new Date(deps.now() - SWEEP_MIN_AGE_MS);
  const rows = await deps.db.stripeEvent.findMany({
    where: { processedAt: null, receivedAt: { lt: cutoff }, attempts: { lt: MAX_EVENT_ATTEMPTS } },
    orderBy: { receivedAt: 'asc' },
    take: SWEEP_BATCH,
  });
  const result: SweepResult = { retried: rows.length, processed: 0, failed: 0 };
  for (const row of rows) {
    try {
      const event = await deps.gateway.retrieveEvent(row.id);
      const outcome = await processRecordedEvent(deps, event);
      if (outcome === 'failed') result.failed += 1;
      else result.processed += 1;
    } catch (err) {
      result.failed += 1;
      deps.logger.error({ err, eventId: row.id }, 'stripe event could not be re-fetched');
      await deps.db.stripeEvent.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 }, lastError: 'events.retrieve failed' },
      });
    }
  }
  if (rows.length > 0) deps.logger.info(result, 'stripe event sweep');
  return result;
}

export interface ReconcileResult {
  seen: number;
  stored: number;
  unknownCustomer: number;
  organisationsRecomputed: number;
}

export async function reconcileSubscriptions(deps: WebhookDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    seen: 0,
    stored: 0,
    unknownCustomer: 0,
    organisationsRecomputed: 0,
  };
  const touched = new Set<string>();
  for await (const state of deps.gateway.listSubscriptions()) {
    result.seen += 1;
    const synced = await syncSubscription(deps, state, 'reconcile');
    if (synced) {
      result.stored += 1;
      touched.add(synced.organisationId);
    } else result.unknownCustomer += 1;
  }
  // Organisations whose state changes with time alone (grace ends) but had no Stripe change.
  const others = await deps.db.subscription.findMany({
    distinct: ['organisationId'],
    select: { organisationId: true },
  });
  for (const { organisationId } of others) {
    if (touched.has(organisationId)) continue;
    await recomputeEntitlements(deps, organisationId, 'reconcile');
    result.organisationsRecomputed += 1;
  }
  deps.logger.info(result, 'stripe subscriptions reconciled');
  return result;
}
