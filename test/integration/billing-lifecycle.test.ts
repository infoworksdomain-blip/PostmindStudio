import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { accessDecision } from '../../src/lib/studio/billing/access-gate';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { reconcileSubscriptions } from '../../src/lib/studio/billing/reconcile';
import { receiveStripeWebhook } from '../../src/lib/studio/billing/webhook';
import { createFakeStripe, webhookDepsFor } from '../helpers/fake-stripe';

// Phase 18 Track C — the scripted equivalent of the Stripe test-clock E2E
// (scripts/billing/e2e-test-clock.ts, operator-run against real Stripe test mode). A simulated
// clock moves one subscription through trial → active → failed payment → grace → read-only →
// recovered, delivering the events Stripe sends (signed, via the real webhook handler) and
// checking what the organisation may do at each step.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('billing lifecycle (scripted test clock)', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  afterAll(async () => {
    await db.$disconnect();
  });

  it('trial → active → failed payment → grace → read-only → recovered', async () => {
    const org = `life-${randomUUID()}`;
    const customer = `cus_${org}`;
    const sub = `sub_${org}`;
    const start = Date.parse('2026-10-01T09:00:00Z');
    let clock = start;
    const fake = createFakeStripe();
    const deps = webhookDepsFor(db, fake, { now: () => clock });
    const reader = createEntitlementsReader({ db, now: () => clock, ttlMs: 0 });
    await db.billingCustomer.create({
      data: { organisationId: org, stripeCustomerId: customer, idempotencyNonce: 'n' },
    });
    const deliver = async (type: string, object: Record<string, unknown>) => {
      const d = fake.deliver(type, object);
      const result = await receiveStripeWebhook(deps, d.raw, d.signature);
      expect(result.outcome).toBe('processed');
    };
    const state = async () => {
      const ent = await reader.forOrganisation(org);
      return {
        tier: ent.tier,
        access: ent.access,
        generate: accessDecision(ent.access, 'POST', '/api/studio/projects/p/generate').allowed,
        billing: accessDecision(ent.access, 'POST', '/api/studio/billing/portal').allowed,
      };
    };
    const invoice = (id: string, status: string) =>
      fake.invoices.set(id, {
        id,
        customerId: customer,
        subscriptionId: sub,
        status,
        hostedInvoiceUrl: `https://invoice.stripe.test/${id}`,
      });

    // Day 0: checkout completes with a 7-day trial on Growth (STANDARD features, 2 HD videos).
    fake.sessions.set(`cs_${org}`, {
      id: `cs_${org}`,
      mode: 'subscription',
      status: 'complete',
      paymentStatus: 'no_payment_required',
      customerId: customer,
      subscriptionId: sub,
      paymentIntentId: null,
      clientReferenceId: org,
      metadata: {},
    });
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'trialing',
      lookupKey: 'studio_growth_monthly',
      trialEnd: new Date(start + 7 * DAY),
    });
    await deliver('checkout.session.completed', { id: `cs_${org}` });
    expect(await state()).toEqual({
      tier: 'STANDARD',
      access: 'full',
      generate: true,
      billing: true,
    });
    expect((await reader.forOrganisation(org)).trial?.shortVideos).toBe(2);

    // Day 7: trial converts, first invoice paid.
    clock = start + 7 * DAY;
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'active',
      lookupKey: 'studio_growth_monthly',
    });
    invoice('in_1', 'paid');
    await deliver('customer.subscription.updated', { id: sub });
    await deliver('invoice.paid', { id: 'in_1' });
    expect(await state()).toEqual({
      tier: 'STANDARD',
      access: 'full',
      generate: true,
      billing: true,
    });
    expect((await reader.forOrganisation(org)).trial).toBeUndefined();

    // Day 37: renewal fails → past_due, 7 days of grace with full access.
    clock = start + 37 * DAY;
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'past_due',
      lookupKey: 'studio_growth_monthly',
    });
    invoice('in_2', 'open');
    await deliver('invoice.payment_failed', { id: 'in_2' });
    expect(await state()).toMatchObject({ access: 'full', generate: true });
    expect((await reader.forOrganisation(org)).graceUntil).toEqual(new Date(clock + 7 * DAY));

    // Day 52: grace over, no event at all → read-only (billing stays open).
    clock = start + 52 * DAY;
    expect(await state()).toEqual({
      tier: 'STANDARD',
      access: 'read_only',
      generate: false,
      billing: true,
    });

    // Day 60: Smart Retries exhausted → unpaid; the nightly reconcile stores it even if the
    // webhook were lost.
    clock = start + 60 * DAY;
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'unpaid',
      lookupKey: 'studio_growth_monthly',
    });
    await reconcileSubscriptions(deps);
    expect(await state()).toMatchObject({ access: 'read_only', generate: false });

    // Day 61: the owner updates the card in the portal; Stripe collects → active, full access.
    clock = start + 61 * DAY;
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'active',
      lookupKey: 'studio_growth_monthly',
    });
    invoice('in_2', 'paid');
    await deliver('invoice.paid', { id: 'in_2' });
    expect(await state()).toEqual({
      tier: 'STANDARD',
      access: 'full',
      generate: true,
      billing: true,
    });

    // Day 70: upgrade to Pro on Your plan (applied on customer.subscription.updated).
    clock = start + 70 * DAY;
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'active',
      lookupKey: 'studio_pro_monthly',
    });
    await deliver('customer.subscription.updated', { id: sub });
    expect((await state()).tier).toBe('STANDARD');
    expect((await reader.forOrganisation(org)).plan).toEqual({
      id: 'pro',
      interval: 'month',
      source: 'stripe',
    });

    // Cancelled at period end → after a paid period, read-only (export and downloads stay).
    clock = start + 100 * DAY;
    fake.setSubscription({
      id: sub,
      customerId: customer,
      status: 'canceled',
      lookupKey: 'studio_plus_monthly',
    });
    await deliver('customer.subscription.deleted', { id: sub });
    expect(await state()).toEqual({
      tier: 'BASIC',
      access: 'read_only',
      generate: false,
      billing: true,
    });
  });
});
