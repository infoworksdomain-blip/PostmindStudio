import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { ConfigurationError, UpstreamServiceError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { resolveStoredEntitlements } from '../../src/lib/studio/billing/entitlements';
import { createStripeClient, isTestModeKey } from '../../src/lib/studio/billing/stripe-client';

// Phase 18 Track C — the Stripe TEST-MODE end-to-end run with a test clock (operator-run; it
// needs a real Stripe test account, a running Studio and webhook forwarding, so CI runs the
// scripted equivalent instead: test/integration/billing-lifecycle.test.ts).
//
//   trial → active → failed payment → grace (past_due, full access) → read-only (unpaid /
//   cancelled after Smart Retries) → recovered (invoice paid, active, full access)
//
// Prerequisites (runbooks/billing-stripe.md "Test-clock E2E"):
//   1. scripts/billing/seed-stripe-test.ts has created the test catalogue;
//   2. Studio runs locally (STUDIO_BILLING=stripe) with STRIPE_SECRET_KEY=sk_test_… and
//      STRIPE_WEBHOOK_SECRET set to the secret `stripe listen` prints;
//   3. `stripe listen --forward-to http://localhost:3000/api/billing/stripe/webhook` is running;
//   4. Billing → Subscriptions and emails → "Manage failed payments": Smart Retries on, and
//      "if all retries fail" = mark the subscription unpaid (or cancel it; both are read-only).
//
//   STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/e2e-test-clock.ts
//
// Docs read 2026-09-29: test clocks https://docs.stripe.com/billing/testing/test-clocks and
// https://docs.stripe.com/api/test_clocks; test cards https://docs.stripe.com/testing
// (pm_card_visa succeeds; pm_card_chargeCustomerFail "Decline after attaching").

const DAY = 24 * 60 * 60;
const WAIT_MS = 120_000;
const POLL_MS = 2_000;

type Expect = { tier?: string; access: string; status?: string };

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function advance(stripe: Stripe, clockId: string, to: number): Promise<void> {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') return;
    if (clock.status === 'internal_failure')
      throw new UpstreamServiceError('test clock advance failed', { clockId });
    await sleep(POLL_MS);
  }
  throw new UpstreamServiceError('test clock did not finish advancing', { clockId });
}

async function expectEntitlements(db: PrismaClient, orgId: string, step: string, want: Expect) {
  const deadline = Date.now() + WAIT_MS;
  let last = 'no row';
  while (Date.now() < deadline) {
    const row = await db.orgEntitlement.findUnique({ where: { organisationId: orgId } });
    const sub = await db.subscription.findFirst({
      where: { organisationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    if (row) {
      const ent = resolveStoredEntitlements(row, new Date());
      last = `${ent.tier}/${ent.access}/${sub?.status ?? '-'}`;
      if (
        ent.access === want.access &&
        (!want.tier || ent.tier === want.tier) &&
        (!want.status || sub?.status === want.status)
      ) {
        logger.info({ step, state: last }, 'step passed');
        return;
      }
    }
    await sleep(POLL_MS);
  }
  throw new UpstreamServiceError(`step "${step}" failed: Studio shows ${last}`, { want });
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key || !isTestModeKey(key))
    throw new ConfigurationError('STRIPE_SECRET_KEY must be a test-mode key (sk_test_…)');
  const stripe = createStripeClient(key);
  const db = new PrismaClient();
  const orgId = `e2e-${randomUUID()}`;
  const start = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: start,
    name: `studio-e2e ${orgId}`,
  });
  try {
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      name: 'Studio E2E',
      metadata: { organisationId: orgId },
    });
    await db.billingCustomer.create({
      data: {
        organisationId: orgId,
        stripeCustomerId: customer.id,
        idempotencyNonce: randomUUID(),
      },
    });
    const good = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: good.id },
    });
    const [price] = (
      await stripe.prices.list({ lookup_keys: ['studio_growth_monthly'], active: true })
    ).data;
    if (!price) throw new ConfigurationError('Run seed-stripe-test.ts first (no plan price)');
    // 26.1: a Growth plan subscription (quantity 1).
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id, quantity: 1 }],
      trial_period_days: 7,
      metadata: { organisationId: orgId },
    });
    await expectEntitlements(db, orgId, 'trial', {
      tier: 'STANDARD',
      access: 'full',
      status: 'trialing',
    });

    await advance(stripe, clock.id, start + 7 * DAY + 3600);
    await expectEntitlements(db, orgId, 'active', {
      tier: 'STANDARD',
      access: 'full',
      status: 'active',
    });

    const bad = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', {
      customer: customer.id,
    });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: bad.id },
    });
    await stripe.subscriptions.update(sub.id, { default_payment_method: bad.id });
    await advance(stripe, clock.id, start + 45 * DAY);
    await expectEntitlements(db, orgId, 'grace', { access: 'full', status: 'past_due' });

    // Smart Retries run for up to a few weeks of clock time; advance past them.
    await advance(stripe, clock.id, start + 75 * DAY);
    await expectEntitlements(db, orgId, 'read-only', { access: 'read_only' });

    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: good.id },
    });
    const latest = await stripe.subscriptions.retrieve(sub.id);
    if (latest.status === 'canceled') {
      logger.warn('the subscription was cancelled after retries: recovery = a new checkout');
    } else {
      await stripe.subscriptions.update(sub.id, { default_payment_method: good.id });
      const open = await stripe.invoices.list({ subscription: sub.id, status: 'open', limit: 10 });
      for (const invoice of open.data) if (invoice.id) await stripe.invoices.pay(invoice.id);
      await expectEntitlements(db, orgId, 'recovered', { access: 'full', status: 'active' });
    }
    logger.info({ orgId, clock: clock.id }, 'stripe test-clock E2E passed');
  } finally {
    await stripe.testHelpers.testClocks
      .del(clock.id)
      .catch((err: unknown) =>
        logger.warn({ err, clock: clock.id }, 'test clock not deleted; delete it in the dashboard'),
      );
    await db.usageCredit.deleteMany({ where: { organisationId: orgId } });
    await db.subscription.deleteMany({ where: { organisationId: orgId } });
    await db.orgEntitlement.deleteMany({ where: { organisationId: orgId } });
    await db.billingCustomer.deleteMany({ where: { organisationId: orgId } });
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'stripe test-clock E2E failed');
  process.exit(1);
});
