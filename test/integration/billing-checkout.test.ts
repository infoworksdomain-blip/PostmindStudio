import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import type Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../src/lib/audit';
import { ConflictError, NotFoundError, ValidationError } from '../../src/lib/errors';
import {
  checkoutParams,
  createBillingService,
  idempotencyKey,
  rotateCheckoutNonce,
  safeReturnPath,
  stripeLocale,
} from '../../src/lib/studio/billing/service';
import { createFakeStripe, type FakeStripe } from '../helpers/fake-stripe';

// Phase 18 §2.7 — Checkout parameters (Stripe Tax, tax ids, address, trial only once,
// idempotency key per (org, intent, nonce)), the portal, invoices and cancellation for deletion.

const hasDb = Boolean(process.env.DATABASE_URL);

describe('checkout parameters (pure)', () => {
  const base = {
    organisationId: 'org-1',
    userId: 'u1',
    locale: 'pt-PT',
  };

  it('channels: quantity = channels, tax, tax ids, address, card always, metadata, trial', () => {
    const params = checkoutParams({
      request: { ...base, intent: { kind: 'channels', channels: 3, interval: 'month' } },
      customer: 'cus_1',
      priceLookup: { priceId: 'price_std' },
      trialPeriodDays: 14,
      appUrl: 'https://studio.test',
    });
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: 'org-1',
      locale: 'pt',
      line_items: [{ price: 'price_std', quantity: 3 }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      payment_method_collection: 'always',
      subscription_data: { metadata: { organisationId: 'org-1' }, trial_period_days: 14 },
      success_url: 'https://studio.test/settings/billing?checkout=success',
      cancel_url: 'https://studio.test/settings/billing?checkout=cancelled',
    });
  });

  it('no trial_period_days when the org is not eligible', () => {
    const params = checkoutParams({
      request: { ...base, intent: { kind: 'channels', channels: 1, interval: 'week' } },
      customer: 'cus_1',
      priceLookup: { priceId: 'p' },
      trialPeriodDays: null,
      appUrl: 'https://studio.test',
    });
    expect(params.subscription_data).toEqual({ metadata: { organisationId: 'org-1' } });
  });

  it('video pack: one-time payment (quantity 1) with the pack in metadata and an invoice', () => {
    const params = checkoutParams({
      request: { ...base, intent: { kind: 'topup', lookupKey: 'studio_pack_hd15' } },
      customer: 'cus_1',
      priceLookup: { priceId: 'price_pack' },
      trialPeriodDays: null,
      appUrl: 'https://studio.test',
    });
    expect(params).toMatchObject({
      mode: 'payment',
      automatic_tax: { enabled: true },
      metadata: { studio_topup: 'studio_pack_hd15', organisationId: 'org-1' },
      invoice_creation: { enabled: true },
      line_items: [{ price: 'price_pack', quantity: 1 }],
    });
    expect((params as Stripe.Checkout.SessionCreateParams).subscription_data).toBeUndefined();
  });

  it('idempotency keys are deterministic per (org, intent, nonce) and Stripe-safe', () => {
    const a = idempotencyKey('org-1', 'sub_studio_basic_monthly', 'n1');
    expect(a).toBe(idempotencyKey('org-1', 'sub_studio_basic_monthly', 'n1'));
    expect(a).not.toBe(idempotencyKey('org-1', 'sub_studio_basic_monthly', 'n2'));
    expect(a).not.toBe(idempotencyKey('org-2', 'sub_studio_basic_monthly', 'n1'));
    expect(a.length).toBeLessThanOrEqual(255);
    expect(a).toMatch(/^studio-[A-Za-z0-9_-]+$/);
  });

  it('maps locales and allowlists return paths', () => {
    expect(stripeLocale('en-US')).toBe('en');
    expect(stripeLocale('zh-Hans')).toBe('zh');
    expect(stripeLocale('ar')).toBe('auto');
    expect(safeReturnPath('/settings/billing?x=1', '/')).toBe('/settings/billing?x=1');
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil', undefined])
      expect(safeReturnPath(bad, '/settings/billing')).toBe('/settings/billing');
  });
});

describe.skipIf(!hasDb)('billing service (Stripe fake, real Postgres)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let fake: FakeStripe;
  let audits: AuditEntry[];
  let org: string;
  const service = () =>
    createBillingService({
      db,
      gateway: fake,
      logger: pino({ level: 'silent' }),
      audit: (e) => audits.push(e),
      now: () => Date.parse('2026-09-29T00:00:00Z'),
      appUrl: 'https://studio.test',
      env: { STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_123' },
    });
  const subscribe = (channels = 2, interval: 'week' | 'month' | 'year' = 'month') =>
    service().createCheckout({
      organisationId: org,
      userId: 'u1',
      intent: { kind: 'channels', channels, interval },
      locale: 'en-GB',
    });
  const lastCheckout = () => {
    const call = fake.calls.filter((c) => c.method === 'createCheckoutSession').at(-1);
    return {
      params: call?.args[0] as Stripe.Checkout.SessionCreateParams,
      key: call?.args[1] as string,
    };
  };

  beforeEach(() => {
    fake = createFakeStripe();
    audits = [];
    org = `co-${randomUUID()}`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('creates the customer once, offers the trial once, sells channels as the quantity, and audits', async () => {
    const { url } = await subscribe(2);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const customer = await db.billingCustomer.findUnique({ where: { organisationId: org } });
    expect(customer?.stripeCustomerId).toBe(`cus_${org}`);
    expect(lastCheckout().params.subscription_data?.trial_period_days).toBe(14);
    expect(lastCheckout().params.line_items).toEqual([
      { price: 'price_studio_channel_monthly', quantity: 2 },
    ]);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'billing.checkout_started', organisationId: org }),
    );

    // A double click (same nonce) reuses the same idempotency key → the same session.
    const firstKey = lastCheckout().key;
    await subscribe(2);
    expect(lastCheckout().key).toBe(firstKey);
    expect(fake.calls.filter((c) => c.method === 'createCustomer')).toHaveLength(1);

    // After a completed checkout the nonce rotates: a deliberate new checkout is a new session.
    await rotateCheckoutNonce(db, org);
    await subscribe(2);
    expect(lastCheckout().key).not.toBe(firstKey);
  });

  it('the trial works on every period but not for an org that trialled or paid before', async () => {
    await subscribe(1, 'week');
    expect(lastCheckout().params.subscription_data?.trial_period_days).toBe(14);
    expect(lastCheckout().params.line_items).toEqual([
      { price: 'price_studio_channel_weekly', quantity: 1 },
    ]);
    await db.orgEntitlement.create({
      data: {
        organisationId: org,
        tier: 'BASIC',
        access: 'none',
        source: 'none',
        trialStartedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await subscribe(6, 'year');
    expect(lastCheckout().params.subscription_data?.trial_period_days).toBeUndefined();
  });

  it('refuses fewer than 1 or more than 6 channels', async () => {
    await expect(subscribe(0)).rejects.toBeInstanceOf(ValidationError);
    await expect(subscribe(7)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a second subscription (plan changes happen on Your plan)', async () => {
    await db.subscription.create({
      data: { id: `sub_${org}`, organisationId: org, stripeCustomerId: 'cus', status: 'active' },
    });
    await expect(subscribe()).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses unknown packs and prices missing in Stripe', async () => {
    await expect(
      service().createCheckout({
        organisationId: org,
        userId: 'u1',
        intent: { kind: 'topup', lookupKey: 'studio_topup_free_lunch' },
        locale: 'en-GB',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The old per-tier top-ups are no longer sold.
    await expect(
      service().createCheckout({
        organisationId: org,
        userId: 'u1',
        intent: { kind: 'topup', lookupKey: 'studio_topup_short10_plus' },
        locale: 'en-GB',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    fake.prices = fake.prices.filter((p) => p.lookupKey !== 'studio_pack_hd5');
    await expect(
      service().createCheckout({
        organisationId: org,
        userId: 'u1',
        intent: { kind: 'topup', lookupKey: 'studio_pack_hd5' },
        locale: 'en-GB',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('portal: needs a billing account; uses the configured portal and a safe return URL', async () => {
    await expect(service().createPortal(org, '/settings/billing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await subscribe();
    const { url } = await service().createPortal(org, 'https://evil.test');
    expect(url).toContain(`cus_${org}`);
    expect(fake.calls.find((c) => c.method === 'createPortalSession')?.args[0]).toEqual({
      customer: `cus_${org}`,
      returnUrl: 'https://studio.test/settings/billing',
      configuration: 'bpc_123',
    });
  });

  it('invoices: empty without a customer, Stripe list with one', async () => {
    await expect(service().listInvoices(org, 10)).resolves.toEqual([]);
    await subscribe();
    const invoices = await service().listInvoices(org, 500);
    expect(invoices[0]).toMatchObject({ number: 'STU-0001', invoicePdfUrl: expect.any(String) });
    expect(fake.calls.find((c) => c.method === 'listInvoices')?.args[1]).toBe(50);
  });

  it('cancelForDeletion cancels live subscriptions and marks the customer deleted', async () => {
    await subscribe();
    await db.subscription.create({
      data: {
        id: `sub_${org}`,
        organisationId: org,
        stripeCustomerId: `cus_${org}`,
        status: 'trialing',
      },
    });
    await db.subscription.create({
      data: {
        id: `sub_old_${org}`,
        organisationId: org,
        stripeCustomerId: `cus_${org}`,
        status: 'canceled',
      },
    });
    await service().cancelForDeletion(org);
    expect(
      fake.calls.filter((c) => c.method === 'cancelSubscription').map((c) => c.args[0]),
    ).toEqual([`sub_${org}`]);
    expect(fake.calls.some((c) => c.method === 'markCustomerDeleted')).toBe(true);
    expect(
      (await db.billingCustomer.findUnique({ where: { organisationId: org } }))?.deletedAt,
    ).not.toBeNull();
    await expect(subscribe()).rejects.toBeInstanceOf(ConflictError);
  });
});
