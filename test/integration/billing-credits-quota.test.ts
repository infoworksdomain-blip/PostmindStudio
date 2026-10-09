import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostCapPausedError, QuotaExceededError } from '../../src/lib/errors';
import {
  capAdjustmentFor,
  createCapAdjustmentLookup,
} from '../../src/lib/studio/billing/cost-adjustments';
import {
  availableCredits,
  consumeCredit,
  creditHeadroomPence,
  creditTopUp,
  refundTopUpCredits,
} from '../../src/lib/studio/billing/credits';
import { trialStateFor } from '../../src/lib/studio/billing/entitlements';
import {
  NO_PLAN_ENTITLEMENTS,
  type Entitlements,
  type EntitlementsReader,
} from '../../src/lib/studio/billing/entitlements-reader';
import { quotaLockKey, withQuotaLock } from '../../src/lib/studio/billing/quota-lock';
import { createCostGuard } from '../../src/lib/studio/cost/guard';
import type { Notifier } from '../../src/lib/studio/notifications/notifier';
import {
  checkGenerateQuota,
  entitlementQuota,
  quotaSlotOf,
  releaseQuotaReservation,
  tierQuota,
} from '../../src/lib/studio/services/plan-quotas';

// Phase 18 §P.3 top-ups and §8 quota races on real Postgres: credits are idempotent per checkout
// session, consumed first-in first-out and once per (project, month), raise the month's cost cap
// by their headroom, and are removed on refund; the standalone quota check is serialised by the
// per-(org, month) advisory lock and reserves its slot; the trial's caps replace the tier's.

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = Date.parse('2026-09-29T12:00:00Z');
const MONTH = '2026-09';

function reader(ent: Partial<Entitlements> = {}): EntitlementsReader {
  const value: Entitlements = {
    tier: 'BASIC',
    access: 'full',
    source: 'stripe',
    limits: { seats: 2, businesses: 1, storageGb: 25 },
    ...ent,
  };
  return { forOrganisation: vi.fn(async () => value), invalidate: vi.fn() };
}

describe('entitlementQuota (pure)', () => {
  const base = tierQuota('STANDARD', {});
  it('trial allowance replaces the tier allowance', () => {
    const trial = trialStateFor(new Date(NOW), null);
    expect(entitlementQuota(base, { ...NO_PLAN_ENTITLEMENTS, trial })).toMatchObject({
      shortVideos: 2, // 26.1: the trial is 2 HD videos (was 5)
      longVideos: 0,
      longMaxSec: 180,
    });
  });
  it('custom (ENTERPRISE) limits override; absent keys keep the tier', () => {
    expect(
      entitlementQuota(base, {
        ...NO_PLAN_ENTITLEMENTS,
        custom: { shortVideos: 999, longMaxSec: null },
      }),
    ).toMatchObject({ shortVideos: 999, longVideos: 1, longMaxSec: null });
    expect(entitlementQuota(base, undefined)).toBe(base);
  });
});

describe.skipIf(!hasDb)('top-up credits and the locked quota check', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const logger = pino({ level: 'silent' });
  let org: string;

  async function project(generatedAt?: Date) {
    return db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Quota',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata: generatedAt
          ? { runId: 'r', generationStart: { runId: 'r', at: generatedAt.toISOString() } }
          : {},
      },
    });
  }

  async function buyPack(lookupKey = 'studio_topup_short10_basic', at = new Date(NOW)) {
    const outcome = await creditTopUp(
      db,
      {
        id: `cs_${randomUUID()}`,
        mode: 'payment',
        status: 'complete',
        paymentStatus: 'paid',
        customerId: null,
        subscriptionId: null,
        paymentIntentId: `pi_${randomUUID()}`,
        clientReferenceId: org,
        metadata: { studio_topup: lookupKey },
      },
      org,
      at,
    );
    return outcome;
  }

  const tenant = () => ({ organisationId: org, organisation: { id: org, planTier: 'BASIC' } });
  const quotaDeps = (ent: Partial<Entitlements> = {}) => ({
    db,
    logger,
    now: () => NOW,
    env: {},
    entitlements: reader(ent),
  });

  beforeEach(() => {
    org = `cq-${randomUUID()}`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('credits a pack once per session; FIFO consumption, once per project and month', async () => {
    const session = {
      id: `cs_${org}`,
      mode: 'payment',
      status: 'complete',
      paymentStatus: 'paid',
      customerId: null,
      subscriptionId: null,
      paymentIntentId: `pi_1_${org}`,
      clientReferenceId: org,
      metadata: { studio_topup: 'studio_topup_short10_standard' },
    };
    expect((await creditTopUp(db, session, org, new Date(NOW))).status).toBe('credited');
    expect((await creditTopUp(db, session, org, new Date(NOW))).status).toBe('duplicate');
    expect(
      (await creditTopUp(db, { ...session, id: 'x', metadata: {} }, org, new Date(NOW))).status,
    ).toBe('unknown_pack');
    const older = await buyPack('studio_topup_short10_basic', new Date(NOW - 86_400_000));
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 20, long: 0 });

    const use = await consumeCredit(db, {
      organisationId: org,
      projectId: `p1-${org}`,
      month: MONTH,
      kind: 'short',
      now: new Date(NOW),
    });
    expect(use?.creditId).toBe(older.status === 'credited' ? older.creditId : '');
    const again = await consumeCredit(db, {
      organisationId: org,
      projectId: `p1-${org}`,
      month: MONTH,
      kind: 'short',
      now: new Date(NOW),
    });
    expect(again).toMatchObject({ id: use?.id, reused: true });
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 19, long: 0 });
    expect(
      await consumeCredit(db, {
        organisationId: org,
        projectId: `p2-${org}`,
        month: MONTH,
        kind: 'long',
        now: new Date(NOW),
      }),
    ).toBeNull();
    // BASIC short pack: £1.00 headroom per consumed credit.
    expect(await creditHeadroomPence(db, org, MONTH)).toBe(100);
    expect(await creditHeadroomPence(db, org, '2026-10')).toBe(0);
  });

  it('expired and refunded credits are never used; a partial refund removes its share', async () => {
    const pack = await buyPack('studio_topup_short10_basic', new Date('2025-09-01T00:00:00Z'));
    expect(pack.status).toBe('credited');
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 0, long: 0 });
    const fresh = await buyPack('studio_topup_long2_standard');
    if (fresh.status !== 'credited') throw new Error('not credited');
    const credit = await db.usageCredit.findUniqueOrThrow({ where: { id: fresh.creditId } });
    await consumeCredit(db, {
      organisationId: org,
      projectId: `p1-${org}`,
      month: MONTH,
      kind: 'long',
      now: new Date(NOW),
    });
    const half = await refundTopUpCredits(
      db,
      {
        id: 'ch',
        paymentIntentId: credit.stripePaymentIntentId,
        customerId: null,
        amount: 3_900,
        amountRefunded: 1_950,
        refunded: false,
      },
      new Date(NOW),
    );
    // 2 credits, 1 spent, 50 % refunded (1 credit) → nothing unused left (23.3: in quarters).
    expect(half).toMatchObject({ removed: 1 });
    expect(
      (await db.usageCredit.findUniqueOrThrow({ where: { id: fresh.creditId } })).remainingQuarters,
    ).toBe(0);
    expect(
      await refundTopUpCredits(
        db,
        {
          id: 'ch',
          paymentIntentId: 'pi_unknown',
          customerId: null,
          amount: 1,
          amountRefunded: 1,
          refunded: true,
        },
        new Date(NOW),
      ),
    ).toBeNull();
  });

  it('the advisory lock serialises the same (org, month) and not others', async () => {
    expect(quotaLockKey('o', MONTH)).toBe(`studio-quota:o:${MONTH}`);
    const order: string[] = [];
    await Promise.all([
      withQuotaLock(db, org, MONTH, async () => {
        order.push('a:start');
        await new Promise((r) => setTimeout(r, 200));
        order.push('a:end');
      }),
      withQuotaLock(db, org, MONTH, async () => {
        order.push('b:start');
        order.push('b:end');
      }),
    ]);
    // No interleaving: whichever ran first finished before the other started.
    expect([order.slice(0, 2), order.slice(2)].map((pair) => pair[0]?.[0])).toEqual([
      order[0]?.[0],
      order[0]?.[0] === 'a' ? 'b' : 'a',
    ]);
    expect(order[1]?.[0]).toBe(order[0]?.[0]);
  });

  it('two racing generates on the last slot: exactly one wins (enforce)', async () => {
    // BASIC allows 20 shorts; 19 are used.
    for (let i = 0; i < 19; i += 1) await project(new Date(NOW - 1_000));
    const a = await project();
    const b = await project();
    const results = await Promise.allSettled([
      checkGenerateQuota(quotaDeps(), tenant(), a.id),
      checkGenerateQuota(quotaDeps(), tenant(), b.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(QuotaExceededError);
    const slots = await db.videoProject.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(slots.filter((p) => quotaSlotOf(p.metadata)?.month === MONTH)).toHaveLength(1);
  });

  it('past the allowance a top-up credit is spent (once) and released if the run does not start', async () => {
    for (let i = 0; i < 20; i += 1) await project(new Date(NOW - 1_000));
    const p = await project();
    await expect(checkGenerateQuota(quotaDeps(), tenant(), p.id)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    await buyPack();
    const ok = await checkGenerateQuota(quotaDeps(), tenant(), p.id);
    expect(ok.violations).toEqual([]);
    expect(ok.reservation).toMatchObject({ fresh: true, creditUseId: expect.any(String) });
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 9, long: 0 });
    // A retry of the same generate (already counted) spends nothing more.
    const retry = await checkGenerateQuota(quotaDeps(), tenant(), p.id);
    expect(retry.reservation?.fresh).toBe(false);
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 9, long: 0 });

    // The run failed to start: slot and credit come back.
    await releaseQuotaReservation({ db, logger }, ok.reservation);
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: p.id } });
    expect(quotaSlotOf(after.metadata)).toBeNull();
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 10, long: 0 });
  });

  it('warn mode never spends credits; the trial allowance is 5 shorts', async () => {
    for (let i = 0; i < 5; i += 1) await project(new Date(NOW - 1_000));
    const p = await project();
    const trial = trialStateFor(new Date(NOW - 86_400_000), null);
    await expect(
      checkGenerateQuota(quotaDeps({ tier: 'STANDARD', trial }), tenant(), p.id),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await buyPack();
    const warn = await checkGenerateQuota(
      { ...quotaDeps({ tier: 'STANDARD', trial }), env: { STUDIO_QUOTA_MODE: 'warn' } },
      tenant(),
      p.id,
    );
    expect(warn.mode).toBe('warn');
    expect(warn.violations[0]?.code).toBe('short_quota');
    expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 10, long: 0 });
  });

  describe('cost-cap adjustments (cost/guard.ts)', () => {
    const notifier: Notifier = {
      notify: vi.fn(async () => ({ created: true })),
      notifyStaff: vi.fn(async () => 0),
    };
    const guardFor = (ent: Partial<Entitlements>) =>
      createCostGuard({
        db,
        caps: {
          orgDailyPenceByTier: { BASIC: 500, STANDARD: 1_500 },
          orgMonthlyPenceByTier: { BASIC: 2_000, STANDARD: 7_300 },
        },
        notifier,
        audit: vi.fn(),
        logger,
        metrics: { costAlerts: { inc: vi.fn() } } as never,
        now: () => NOW,
        adjustments: createCapAdjustmentLookup({ db, entitlements: reader(ent) }),
      });
    const spend = (day: string, costPence: number) =>
      db.providerUsage.create({
        data: {
          organisationId: org,
          provider: `p-${randomUUID()}`,
          day: new Date(day),
          costPence,
        } as Prisma.ProviderUsageUncheckedCreateInput,
      });

    it('consumed credits raise the monthly cap by their headroom', async () => {
      await buyPack();
      await consumeCredit(db, {
        organisationId: org,
        projectId: `p1-${org}`,
        month: MONTH,
        kind: 'short',
        now: new Date(NOW),
      });
      await consumeCredit(db, {
        organisationId: org,
        projectId: `p2-${org}`,
        month: MONTH,
        kind: 'short',
        now: new Date(NOW),
      });
      const usage = await guardFor({}).usage({ organisationId: org, planTier: 'BASIC' });
      expect(usage.find((u) => u.scope === 'ORG_MONTHLY')?.capPence).toBe(2_000 + 200);
      expect(await capAdjustmentFor(db, reader({}), org, new Date(NOW))).toEqual({
        monthlyHeadroomPence: 200,
      });
    });

    it('a trial is capped at £10 a day and £15 in total, across months', async () => {
      const trial = trialStateFor(
        new Date('2026-08-25T00:00:00Z'),
        new Date('2026-09-08T00:00:00Z'),
      );
      await spend('2026-08-28', 1_200);
      const usage = await guardFor({ tier: 'STANDARD', source: 'trial', trial }).usage({
        organisationId: org,
        planTier: 'STANDARD',
      });
      expect(usage.find((u) => u.scope === 'ORG_DAILY')?.capPence).toBe(1_000);
      expect(usage.find((u) => u.scope === 'ORG_MONTHLY')?.capPence).toBe(300);
      await spend('2026-09-29', 300);
      await expect(
        guardFor({ tier: 'STANDARD', source: 'trial', trial }).assertNotPaused({
          organisationId: org,
          planTier: 'STANDARD',
        }),
      ).rejects.toBeInstanceOf(CostCapPausedError);
    });
  });
});
