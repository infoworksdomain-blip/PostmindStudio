import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { reconcileSubscriptions, sweepStripeEvents } from '../../src/lib/studio/billing/reconcile';
import { receiveStripeWebhook } from '../../src/lib/studio/billing/webhook';
import {
  createFakeStripe,
  subscriptionPayload,
  webhookDepsFor,
  WEBHOOK_SECRET,
  type FakeStripe,
} from '../helpers/fake-stripe';
import { createStripeClient } from '../../src/lib/studio/billing/stripe-client';

// Phase 18 §2.7 / §5.7 — the Stripe webhook on real Postgres with a scripted Stripe and REAL
// signatures: verification (valid, invalid, stale), dedupe, out-of-order safety through re-fetch,
// never trusting metadata, grace, paid, trial abuse, top-ups and refunds, disputes, and the two
// safety nets (event sweeper, nightly reconcile).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('stripe webhook', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let fake: FakeStripe;
  let deps: ReturnType<typeof webhookDepsFor>;
  let org: string;
  let customer: string;
  const now = Date.parse('2026-09-29T12:00:00Z');
  let clock = now;

  async function entitlement() {
    const reader = createEntitlementsReader({ db, now: () => clock });
    return reader.forOrganisation(org);
  }

  async function send(type: string, object: Record<string, unknown>, id?: string) {
    const delivery = fake.deliver(type, object, id);
    return receiveStripeWebhook(deps, delivery.raw, delivery.signature);
  }

  beforeEach(async () => {
    clock = now;
    fake = createFakeStripe();
    deps = webhookDepsFor(db, fake, { now: () => clock });
    org = `wh-${randomUUID()}`;
    customer = `cus_${org}`;
    await db.billingCustomer.create({
      data: { organisationId: org, stripeCustomerId: customer, idempotencyNonce: 'n1' },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  describe('signature', () => {
    it('accepts a valid signature and records the event once', async () => {
      const sub = fake.setSubscription({ id: `sub_${org}`, customerId: customer });
      const result = await send('customer.subscription.created', subscriptionPayload(sub));
      expect(result.outcome).toBe('processed');
      const row = await db.stripeEvent.findUnique({ where: { id: result.eventId } });
      expect(row?.processedAt).not.toBeNull();
      expect(row?.objectId).toBe(sub.id);
    });

    it('rejects a bad signature (400) without recording anything', async () => {
      const delivery = fake.deliver('customer.subscription.created', { id: 'sub_x' });
      const forged = createStripeClient('sk_test_x').webhooks.generateTestHeaderString({
        payload: delivery.raw,
        secret: 'whsec_wrong',
      });
      await expect(receiveStripeWebhook(deps, delivery.raw, forged)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(receiveStripeWebhook(deps, delivery.raw, null)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        receiveStripeWebhook(deps, `${delivery.raw} `, delivery.signature),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await db.stripeEvent.findUnique({ where: { id: delivery.event.id } })).toBeNull();
    });

    it('rejects a stale signature (older than the 300 s tolerance)', async () => {
      const delivery = fake.deliver('customer.subscription.created', { id: 'sub_x' });
      const stale = createStripeClient('sk_test_x').webhooks.generateTestHeaderString({
        payload: delivery.raw,
        secret: WEBHOOK_SECRET,
        timestamp: Math.floor(Date.now() / 1000) - 301,
      });
      await expect(receiveStripeWebhook(deps, delivery.raw, stale)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('dedupe and ordering', () => {
    it('a replayed event is acknowledged as a duplicate and not processed again', async () => {
      const sub = fake.setSubscription({ id: `sub_${org}`, customerId: customer });
      const delivery = fake.deliver('customer.subscription.updated', subscriptionPayload(sub));
      const first = await receiveStripeWebhook(deps, delivery.raw, delivery.signature);
      const retrievesAfterFirst = fake.calls.filter(
        (c) => c.method === 'retrieveSubscription',
      ).length;
      const again = await receiveStripeWebhook(deps, delivery.raw, delivery.signature);
      expect(first.outcome).toBe('processed');
      expect(again.outcome).toBe('duplicate');
      expect(fake.calls.filter((c) => c.method === 'retrieveSubscription')).toHaveLength(
        retrievesAfterFirst,
      );
    });

    it('out of order: an old "active" payload after the cancel still leaves the live state', async () => {
      const id = `sub_${org}`;
      fake.setSubscription({ id, customerId: customer, status: 'active' });
      const oldActive = fake.deliver(
        'customer.subscription.updated',
        subscriptionPayload(fake.subscriptions.get(id)!, 'active'),
      );
      // Stripe has since cancelled it; the cancel event arrives FIRST.
      fake.setSubscription({ id, customerId: customer, status: 'canceled' });
      await send('customer.subscription.deleted', { id, customer, status: 'canceled' });
      await receiveStripeWebhook(deps, oldActive.raw, oldActive.signature);
      expect((await db.subscription.findUnique({ where: { id } }))?.status).toBe('canceled');
      expect((await entitlement()).access).toBe('none');
      expect(deps.mailer.sent.map((m) => m.template)).toEqual([]); // no owners in this org
    });

    it('never trusts metadata: a subscription of an unknown customer is ignored', async () => {
      const sub = fake.setSubscription({
        id: `sub_foreign_${org}`,
        customerId: 'cus_someone_else',
        metadataOrganisationId: org,
      });
      const result = await send('customer.subscription.created', subscriptionPayload(sub));
      expect(result.outcome).toBe('processed');
      expect(await db.subscription.findUnique({ where: { id: sub.id } })).toBeNull();
      expect(await db.orgEntitlement.findUnique({ where: { organisationId: org } })).toBeNull();
    });

    it('metadata naming another organisation is overridden by billing_customers', async () => {
      const sub = fake.setSubscription({
        id: `sub_${org}`,
        customerId: customer,
        metadataOrganisationId: 'org-attacker',
      });
      await send('customer.subscription.created', subscriptionPayload(sub));
      expect((await db.subscription.findUnique({ where: { id: sub.id } }))?.organisationId).toBe(
        org,
      );
      expect(
        await db.orgEntitlement.findUnique({ where: { organisationId: 'org-attacker' } }),
      ).toBeNull();
    });
  });

  describe('21.5 channels and scheduled changes', () => {
    it('reads the quantity and interval of a channel subscription (customer.subscription.updated)', async () => {
      const id = `sub_${org}`;
      fake.setSubscription({
        id,
        customerId: customer,
        lookupKey: 'studio_channel_weekly',
        priceId: 'price_studio_channel_weekly',
        interval: 'week',
        quantity: 4,
      });
      await send('customer.subscription.updated', { id });
      expect(await db.subscription.findUnique({ where: { id } })).toMatchObject({
        quantity: 4,
        interval: 'week',
        lookupKey: 'studio_channel_weekly',
      });
      expect((await entitlement()).channelPlan).toEqual({
        channels: 4,
        interval: 'week',
        source: 'stripe',
      });
    });

    it('subscription_schedule events store and clear the change waiting for the period end', async () => {
      const id = `sub_${org}`;
      const state = fake.setSubscription({ id, customerId: customer, quantity: 3 });
      await send('customer.subscription.created', { id });
      fake.subscriptions.set(id, {
        ...state,
        scheduleId: 'sub_sched_1',
        pendingChange: {
          quantity: 1,
          priceId: 'price_studio_channel_yearly',
          lookupKey: 'studio_channel_yearly',
          effectiveAt: new Date('2026-10-01T00:00:00Z'),
        },
      });
      await send('subscription_schedule.updated', { id: 'sub_sched_1', subscription: id });
      expect(await db.subscription.findUnique({ where: { id } })).toMatchObject({
        scheduleId: 'sub_sched_1',
        pendingQuantity: 1,
        pendingLookupKey: 'studio_channel_yearly',
      });
      fake.subscriptions.set(id, { ...state, scheduleId: null, pendingChange: null });
      await send('subscription_schedule.released', {
        id: 'sub_sched_1',
        subscription: null,
        released_subscription: id,
      });
      expect(await db.subscription.findUnique({ where: { id } })).toMatchObject({
        scheduleId: null,
        pendingQuantity: null,
      });
    });
  });

  describe('lifecycle events', () => {
    it('payment failed → grace (full access, banner) → read_only when grace ends → paid restores', async () => {
      const id = `sub_${org}`;
      fake.setSubscription({
        id,
        customerId: customer,
        status: 'active',
        lookupKey: 'studio_plus_monthly',
      });
      await send('customer.subscription.created', { id });
      fake.invoices.set(`in_1_${org}`, {
        id: `in_1_${org}`,
        customerId: customer,
        subscriptionId: id,
        status: 'paid',
        hostedInvoiceUrl: null,
      });
      await send('invoice.paid', { id: `in_1_${org}` });
      expect(
        (await db.orgEntitlement.findUnique({ where: { organisationId: org } }))?.everPaidAt,
      ).not.toBeNull();

      fake.setSubscription({
        id,
        customerId: customer,
        status: 'past_due',
        lookupKey: 'studio_plus_monthly',
      });
      fake.invoices.set(`in_2_${org}`, {
        id: `in_2_${org}`,
        customerId: customer,
        subscriptionId: id,
        status: 'open',
        hostedInvoiceUrl: 'https://invoice.stripe.test/in_2',
      });
      await send('invoice.payment_failed', { id: `in_2_${org}` });
      const row = await db.orgEntitlement.findUnique({ where: { organisationId: org } });
      expect(row?.graceUntil?.toISOString()).toBe('2026-10-06T12:00:00.000Z');
      expect(await entitlement()).toMatchObject({ tier: 'PLUS', access: 'full' });
      expect(deps.audits.some((a) => a.action === 'billing.payment_failed')).toBe(true);

      clock = Date.parse('2026-10-06T12:00:01Z');
      expect(await entitlement()).toMatchObject({ tier: 'PLUS', access: 'read_only' });

      fake.setSubscription({
        id,
        customerId: customer,
        status: 'active',
        lookupKey: 'studio_plus_monthly',
      });
      fake.invoices.set(`in_2_${org}`, { ...fake.invoices.get(`in_2_${org}`)!, status: 'paid' });
      await send('invoice.paid', { id: `in_2_${org}` });
      expect(await entitlement()).toMatchObject({ tier: 'PLUS', access: 'full' });
      expect(
        (await db.orgEntitlement.findUnique({ where: { organisationId: org } }))?.graceUntil,
      ).toBeNull();
    });

    it('trial: STANDARD with the trial allowance; a card that already trialled ends the trial', async () => {
      const first = `sub_a_${org}`;
      fake.fingerprints.set('pm_card', `fp_${org}`);
      fake.setSubscription({
        id: first,
        customerId: customer,
        status: 'trialing',
        lookupKey: 'studio_standard_monthly',
        trialEnd: new Date('2026-10-13T12:00:00Z'),
        defaultPaymentMethodId: 'pm_card',
      });
      await send('customer.subscription.created', { id: first });
      const ent = await entitlement();
      expect(ent).toMatchObject({ tier: 'STANDARD', access: 'full', source: 'trial' });
      expect(ent.trial).toMatchObject({ shortVideos: 5, longVideos: 0, totalCostCapPence: 1_500 });
      expect(
        await db.trialFingerprint.findUnique({ where: { fingerprint: `fp_${org}` } }),
      ).toMatchObject({
        organisationId: org,
      });
      expect(fake.calls.some((c) => c.method === 'endTrialNow')).toBe(false);

      // Another organisation, same card → its trial is ended at once.
      const other = `wh-other-${randomUUID()}`;
      await db.billingCustomer.create({
        data: { organisationId: other, stripeCustomerId: `cus_${other}`, idempotencyNonce: 'n' },
      });
      fake.setSubscription({
        id: `sub_${other}`,
        customerId: `cus_${other}`,
        status: 'trialing',
        lookupKey: 'studio_standard_monthly',
        trialEnd: new Date('2026-10-13T12:00:00Z'),
        defaultPaymentMethodId: 'pm_card',
      });
      await send('customer.subscription.created', { id: `sub_${other}` });
      const ended = fake.calls.find((c) => c.method === 'endTrialNow');
      expect(ended?.args).toEqual([`sub_${other}`, `studio:trial-end:sub_${other}`]);
    });

    it('trial_will_end emails every owner in their locale', async () => {
      const userId = `u-${org}`;
      await db.user.create({
        data: { id: userId, name: 'Owner', email: `${userId}@t.test`, locale: 'fr' },
      });
      await db.organization.create({ data: { id: org, name: 'Org', slug: org } });
      await db.member.create({
        data: { id: `m-${org}`, organizationId: org, userId, role: 'owner' },
      });
      const id = `sub_${org}`;
      fake.setSubscription({
        id,
        customerId: customer,
        status: 'trialing',
        trialEnd: new Date('2026-10-02T00:00:00Z'),
      });
      await send('customer.subscription.trial_will_end', { id });
      expect(deps.mailer.sent).toEqual([
        expect.objectContaining({
          template: 'trialEnding',
          to: `${userId}@t.test`,
          locale: 'fr',
          // 21.5: the per-channel plan is named by the product, never a tier.
          params: { planName: 'PostMind Studio', trialEndsAt: '2026-10-02T00:00:00.000Z' },
        }),
      ]);
      await db.member.deleteMany({ where: { organizationId: org } });
      await db.organization.delete({ where: { id: org } });
      await db.user.delete({ where: { id: userId } });
    });

    it('a paid top-up checkout credits once; a refund removes the unused credits', async () => {
      const session = `cs_${org}`;
      fake.sessions.set(session, {
        id: session,
        mode: 'payment',
        status: 'complete',
        paymentStatus: 'paid',
        customerId: customer,
        subscriptionId: null,
        paymentIntentId: `pi_${org}`,
        clientReferenceId: org,
        metadata: { organisationId: org, studio_topup: 'studio_topup_short10_standard' },
      });
      await send('checkout.session.completed', { id: session });
      await send('checkout.session.completed', { id: session }); // a second event id, same session
      const credits = await db.usageCredit.findMany({ where: { organisationId: org } });
      expect(credits).toHaveLength(1);
      expect(credits[0]).toMatchObject({ kind: 'short', quantity: 10, remaining: 10 });
      expect(deps.audits.filter((a) => a.action === 'billing.topup_purchased')).toHaveLength(1);

      fake.charges.set(`ch_${org}`, {
        id: `ch_${org}`,
        paymentIntentId: `pi_${org}`,
        customerId: customer,
        amount: 3_900,
        amountRefunded: 3_900,
        refunded: true,
      });
      await send('charge.refunded', { id: `ch_${org}` });
      const after = await db.usageCredit.findFirst({ where: { organisationId: org } });
      expect(after?.remaining).toBe(0);
      expect(after?.refundedAt).not.toBeNull();
    });

    it('an unpaid top-up session (async payment pending) credits nothing', async () => {
      const session = `cs_pending_${org}`;
      fake.sessions.set(session, {
        id: session,
        mode: 'payment',
        status: 'complete',
        paymentStatus: 'unpaid',
        customerId: customer,
        subscriptionId: null,
        paymentIntentId: null,
        clientReferenceId: org,
        metadata: { studio_topup: 'studio_topup_short10_basic' },
      });
      await send('checkout.session.completed', { id: session });
      expect(await db.usageCredit.count({ where: { organisationId: org } })).toBe(0);
    });

    it('a dispute is audited for staff', async () => {
      fake.charges.set(`ch_d_${org}`, {
        id: `ch_d_${org}`,
        paymentIntentId: null,
        customerId: customer,
        amount: 2_900,
        amountRefunded: 0,
        refunded: false,
      });
      await send('charge.dispute.created', { id: `dp_${org}`, charge: `ch_d_${org}` });
      expect(deps.audits).toContainEqual(
        expect.objectContaining({ action: 'billing.dispute_created', organisationId: org }),
      );
    });

    it('unhandled event types are recorded and ignored', async () => {
      const result = await send('product.created', { id: 'prod_x' });
      expect(result.outcome).toBe('ignored');
    });
  });

  describe('safety nets', () => {
    it('a failed event stays unprocessed and the sweeper processes it later', async () => {
      const id = `sub_${org}`;
      fake.setSubscription({ id, customerId: customer, status: 'active' });
      fake.failNext = { method: 'retrieveSubscription', error: new Error('stripe 503') };
      const result = await send('customer.subscription.created', { id });
      expect(result.outcome).toBe('failed');
      const row = await db.stripeEvent.findUnique({ where: { id: result.eventId } });
      expect(row).toMatchObject({ processedAt: null, attempts: 1, lastError: 'stripe 503' });

      clock = now + 3 * 60_000;
      await db.stripeEvent.update({
        where: { id: result.eventId },
        data: { receivedAt: new Date(now - 5 * 60_000) },
      });
      const sweep = await sweepStripeEvents(deps);
      expect(sweep.processed).toBeGreaterThanOrEqual(1);
      expect(
        (await db.stripeEvent.findUnique({ where: { id: result.eventId } }))?.processedAt,
      ).not.toBeNull();
      expect((await entitlement()).access).toBe('full');
    });

    it('the nightly reconcile stores every Stripe subscription, even with no webhook', async () => {
      const id = `sub_${org}`;
      fake.setSubscription({
        id,
        customerId: customer,
        status: 'active',
        lookupKey: 'studio_basic_yearly',
      });
      const result = await reconcileSubscriptions(deps);
      expect(result.stored).toBeGreaterThanOrEqual(1);
      expect(await db.subscription.findUnique({ where: { id } })).toMatchObject({
        status: 'active',
        interval: 'year',
        unitAmountPence: 29_000,
      });
      expect(await entitlement()).toMatchObject({ tier: 'BASIC', access: 'full' });
    });
  });
});
