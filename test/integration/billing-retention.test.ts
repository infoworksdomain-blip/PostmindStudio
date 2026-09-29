import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../src/lib/audit';
import { createMemoryAuthMailer } from '../../src/lib/email/auth-mailer';
import { ConfigurationError } from '../../src/lib/errors';
import { parseOverrides } from '../../src/lib/studio/billing/entitlements';
import {
  cancelledRetentionDays,
  purgeCancelledOrganisations,
} from '../../src/lib/studio/billing/retention';
import { receiveStripeWebhook } from '../../src/lib/studio/billing/webhook';
import { createFakeStripe, webhookDepsFor } from '../helpers/fake-stripe';

// Phase 18 open question 3 — a paid organisation whose subscription ended stays read-only for
// STUDIO_CANCELLED_RETENTION_DAYS, then its owners are emailed and the existing purge takes over.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe('cancelledRetentionDays', () => {
  it('defaults to 90; 0 disables; invalid values are a configuration error', () => {
    expect(cancelledRetentionDays({})).toBe(90);
    expect(cancelledRetentionDays({ STUDIO_CANCELLED_RETENTION_DAYS: '0' })).toBe(0);
    expect(cancelledRetentionDays({ STUDIO_CANCELLED_RETENTION_DAYS: '30' })).toBe(30);
    for (const bad of ['-1', '2.5', 'soon', '99999'])
      expect(() => cancelledRetentionDays({ STUDIO_CANCELLED_RETENTION_DAYS: bad })).toThrow(
        ConfigurationError,
      );
  });
});

describe.skipIf(!hasDb)('cancelled organisation retention', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);

  afterAll(async () => {
    await db.$disconnect();
  });

  async function cancelledOrg(start: number) {
    const org = `ret-${randomUUID()}`;
    const customer = `cus_${org}`;
    const sub = `sub_${org}`;
    let clock = start;
    const fake = createFakeStripe();
    const deps = webhookDepsFor(db, fake, { now: () => clock });
    await db.billingCustomer.create({
      data: { organisationId: org, stripeCustomerId: customer, idempotencyNonce: 'n' },
    });
    const deliver = async (type: string, object: Record<string, unknown>) => {
      const d = fake.deliver(type, object);
      await receiveStripeWebhook(deps, d.raw, d.signature);
    };
    fake.setSubscription({ id: sub, customerId: customer, status: 'active' });
    fake.invoices.set(`in_${org}`, {
      id: `in_${org}`,
      customerId: customer,
      subscriptionId: sub,
      status: 'paid',
      hostedInvoiceUrl: null,
    });
    await deliver('invoice.paid', { id: `in_${org}` });
    clock = start + DAY;
    fake.setSubscription({ id: sub, customerId: customer, status: 'canceled' });
    await deliver('customer.subscription.deleted', { id: sub });
    return {
      org,
      sub,
      fake,
      deliver,
      setClock: (t: number) => {
        clock = t;
      },
    };
  }

  function retentionDeps(now: number, env: Record<string, string> = {}) {
    const audits: AuditEntry[] = [];
    const mailer = createMemoryAuthMailer();
    const purge = vi.fn(async () => ({ graceUntil: new Date(now + 30 * DAY).toISOString() }));
    return {
      audits,
      mailer,
      purge,
      deps: {
        db,
        logger: pino({ level: 'silent' }),
        audit: (e: AuditEntry) => audits.push(e),
        now: () => now,
        env,
        mailer,
        purge,
      },
    };
  }

  it('the clock starts at cancellation; before the retention nothing happens', async () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const { org } = await cancelledOrg(start);
    const row = await db.orgEntitlement.findUniqueOrThrow({ where: { organisationId: org } });
    expect(row.access).toBe('read_only');
    expect(parseOverrides(row.overrides).retention?.cancelledAt).toBe(
      new Date(start + DAY).toISOString(),
    );
    const r = retentionDeps(start + 60 * DAY);
    const out = await purgeCancelledOrganisations(r.deps);
    expect(out.purged).not.toContain(org);
    expect(r.purge).not.toHaveBeenCalledWith(org);
  });

  it('after the retention: owners are emailed once and the purge is handed off once', async () => {
    const start = Date.parse('2026-02-01T00:00:00Z');
    const { org } = await cancelledOrg(start);
    const userId = `u-${org}`;
    await db.user.create({
      data: { id: userId, name: 'O', email: `${userId}@t.test`, locale: 'de' },
    });
    await db.organization.create({ data: { id: org, name: 'Org', slug: org } });
    await db.member.create({
      data: { id: `m-${org}`, organizationId: org, userId, role: 'owner' },
    });

    const r = retentionDeps(start + 92 * DAY);
    const out = await purgeCancelledOrganisations(r.deps);
    expect(out.purged).toContain(org);
    expect(r.purge).toHaveBeenCalledWith(org);
    expect(r.mailer.sent).toEqual([
      expect.objectContaining({
        template: 'orgDeletionScheduled',
        to: `${userId}@t.test`,
        locale: 'de',
        // The organisation's name and the day the purge grace (30 days by default) ends.
        params: {
          organisationName: 'Org',
          deleteAt: new Date(start + 92 * DAY + 30 * DAY).toISOString(),
        },
      }),
    ]);
    expect(r.audits).toContainEqual(
      expect.objectContaining({
        action: 'org.deleted',
        organisationId: org,
        metadata: expect.objectContaining({ reason: 'cancelled_retention_elapsed' }),
      }),
    );
    const retention = parseOverrides(
      (await db.orgEntitlement.findUniqueOrThrow({ where: { organisationId: org } })).overrides,
    ).retention;
    expect(retention?.notifiedAt).toBeDefined();
    expect(retention?.purgeRequestedAt).toBeDefined();

    const again = retentionDeps(start + 93 * DAY);
    await purgeCancelledOrganisations(again.deps);
    expect(again.purge).not.toHaveBeenCalledWith(org);
    expect(again.mailer.sent).toEqual([]);

    await db.member.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
    await db.user.delete({ where: { id: userId } });
  });

  it('subscribing again stops the clock; 0 days disables the purge', async () => {
    const start = Date.parse('2026-03-01T00:00:00Z');
    const { org, sub, fake, deliver, setClock } = await cancelledOrg(start);
    const disabled = retentionDeps(start + 200 * DAY, { STUDIO_CANCELLED_RETENTION_DAYS: '0' });
    expect((await purgeCancelledOrganisations(disabled.deps)).enabled).toBe(false);
    expect(disabled.purge).not.toHaveBeenCalled();

    setClock(start + 10 * DAY);
    fake.setSubscription({ id: `${sub}_new`, customerId: `cus_${org}`, status: 'active' });
    await deliver('customer.subscription.created', { id: `${sub}_new` });
    const row = await db.orgEntitlement.findUniqueOrThrow({ where: { organisationId: org } });
    expect(parseOverrides(row.overrides).retention).toBeUndefined();
    const r = retentionDeps(start + 200 * DAY);
    await purgeCancelledOrganisations(r.deps);
    expect(r.purge).not.toHaveBeenCalledWith(org);
  });
});
