import { toErrorResponse } from '../../errors';
import { getCorrelationId, withContext } from '../../logger';
import { getApiDeps } from '../api/context';
import { receiveStripeWebhook } from './webhook';
import { billingJobDepsFromEnv, type BillingJobDeps } from './wiring';

// Phase 18 §2.7 — the handler behind POST /api/billing/stripe/webhook (the route file only
// re-exports it, because Next.js route modules may export nothing but handlers and config).
// Public: the Stripe signature is the authentication. The raw body is read with req.text() and
// never parsed before verification. Replies 2xx once the event is recorded (processed,
// duplicate, ignored, or failed-and-queued for the sweeper); 400 for a missing or bad signature;
// 503 while Stripe billing is not configured. Disputes are audited and logged at warn level
// (runbooks/billing-stripe.md: alert on "stripe dispute opened").

let testDeps: BillingJobDeps | undefined;

/** Test hook: install webhook dependencies (pass undefined to reset). */
export function setWebhookDepsForTest(next: BillingJobDeps | undefined): void {
  testDeps = next;
}

async function webhookDeps(): Promise<BillingJobDeps | undefined> {
  if (testDeps) return testDeps;
  const deps = await getApiDeps();
  return billingJobDepsFromEnv({
    db: deps.db,
    logger: deps.logger,
    audit: deps.audit,
    mailer: deps.mailer,
  });
}

export async function handleStripeWebhookRequest(req: Request): Promise<Response> {
  const correlationId = getCorrelationId(req);
  const log = withContext({ correlationId });
  try {
    const deps = await webhookDeps();
    if (!deps) {
      log.error('stripe webhook received but Stripe billing is not configured');
      return Response.json({ ok: false, error: 'billing_not_configured' }, { status: 503 });
    }
    const raw = await req.text();
    const result = await receiveStripeWebhook(deps, raw, req.headers.get('stripe-signature'));
    log.info(result, 'stripe webhook');
    return Response.json({ ok: true, received: true, outcome: result.outcome });
  } catch (err) {
    const response = toErrorResponse(err);
    if (response.status >= 500) log.error({ err }, 'stripe webhook error');
    else log.warn({ status: response.status }, 'stripe webhook rejected');
    return response;
  }
}
