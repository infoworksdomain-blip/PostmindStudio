import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaExceededError } from '../../src/lib/errors';
import {
  availableCreditQuarters,
  availableCredits,
  consumeCredit,
  creditTopUp,
  refundTopUpCredits,
} from '../../src/lib/studio/billing/credits';
import type {
  Entitlements,
  EntitlementsReader,
} from '../../src/lib/studio/billing/entitlements-reader';
import type { PlanId, PlanInterval } from '../../src/lib/studio/billing/plans';
import {
  checkGenerateQuota,
  quotaSlotOf,
  releaseQuotaReservation,
  usageView,
} from '../../src/lib/studio/services/plan-quotas';
import { newUgcStyle } from '../../src/lib/studio/ugc/style';

// BACKLOG 23.3 (operator decision 2026-10-06) on real Postgres: carousels, slideshows, wall of
// text and hook + demo count as ¼ of a video against the plan allowance (monthly, weekly and
// yearly windows) and against HD video packs; AI videos 1, UGC actor videos 2. Pack balances,
// uses, releases and refunds are integer quarters; the migration's backfill is idempotent.

const hasDb = Boolean(process.env.DATABASE_URL);
// Wednesday 30 September 2026 (ISO week 2026-W40 runs Monday 28 Sept to Sunday 4 Oct).
const NOW = Date.parse('2026-09-30T12:00:00Z');
const MONTH = '2026-09';

describe.skipIf(!hasDb)(
  '23.3 quick posts count as a quarter of a video',
  { timeout: 90_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const logger = pino({ level: 'silent' });
    let org: string;

    const onPlan = (id: PlanId, interval: PlanInterval): EntitlementsReader => {
      const value: Entitlements = {
        tier: 'STANDARD',
        access: 'full',
        source: 'stripe',
        limits: { seats: 3, businesses: 1, storageGb: 100 },
        plan: { id, interval, source: 'stripe' },
      };
      return { forOrganisation: vi.fn(async () => value), invalidate: vi.fn() };
    };
    const tenant = () => ({ organisationId: org, organisation: { id: org, planTier: 'STANDARD' } });
    const deps = (entitlements: EntitlementsReader) => ({
      db,
      logger,
      now: () => NOW,
      env: {},
      entitlements,
    });

    async function project(sourceType: string, generatedAt?: Date, metadata: object = {}) {
      return db.videoProject.create({
        data: {
          organisationId: org,
          businessId: 'biz',
          createdByUserId: 'user-1',
          name: sourceType,
          state: 'DRAFT',
          sourceType: sourceType as Prisma.VideoProjectCreateInput['sourceType'],
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
          metadata: {
            ...metadata,
            ...(generatedAt && {
              runId: 'r',
              generationStart: { runId: 'r', at: generatedAt.toISOString() },
            }),
          },
        },
      });
    }

    async function many(n: number, sourceType: string, at = new Date(NOW - 60_000)) {
      for (let i = 0; i < n; i += 1) await project(sourceType, at);
    }

    async function buyPack(lookupKey = 'studio_pack_hd5') {
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
        new Date(NOW),
      );
      if (outcome.status !== 'credited') throw new Error(`pack not credited: ${outcome.status}`);
      return outcome.creditId;
    }

    beforeEach(() => {
      org = `qq-${randomUUID()}`;
    });

    afterAll(async () => {
      await db.$disconnect();
    });

    it('a monthly Starter plan fits 32 quick posts; the usage view shows quarter videos', async () => {
      await many(10, 'CAROUSEL');
      await many(10, 'SLIDESHOW');
      await many(6, 'WALL_OF_TEXT');
      await many(5, 'HOOK_DEMO');
      // 31 quarters used: one quick post still fits, an AI video does not.
      const video = await project('BRIEF');
      await expect(
        checkGenerateQuota(deps(onPlan('starter', 'month')), tenant(), video.id),
      ).rejects.toBeInstanceOf(QuotaExceededError);
      const carousel = await project('CAROUSEL');
      const ok = await checkGenerateQuota(deps(onPlan('starter', 'month')), tenant(), carousel.id);
      expect(ok.violations).toEqual([]);
      expect(ok.reservation).toMatchObject({ fresh: true, month: MONTH });
      const view = await usageView(
        { db, now: () => NOW, env: {} },
        org,
        'STANDARD',
        undefined,
        await onPlan('starter', 'month').forOrganisation(org),
      );
      expect(view.videos.short).toMatchObject({
        used: 8,
        limit: 8,
        usedQuarters: 32,
        limitQuarters: 32,
        percent: 100,
      });
      // The 33rd quick post is refused.
      const extra = await project('SLIDESHOW');
      await expect(
        checkGenerateQuota(deps(onPlan('starter', 'month')), tenant(), extra.id),
      ).rejects.toBeInstanceOf(QuotaExceededError);
    });

    it('mixed formats: video 4 + UGC 8 + quick posts 1 each', async () => {
      await project('BRIEF', new Date(NOW - 60_000));
      await project('BRIEF', new Date(NOW - 60_000), { ugc: newUgcStyle({}, 1) });
      await many(3, 'CAROUSEL');
      const view = await usageView(
        { db, now: () => NOW, env: {} },
        org,
        'STANDARD',
        undefined,
        await onPlan('growth', 'month').forOrganisation(org),
      );
      expect(view.videos.short).toMatchObject({ usedQuarters: 15, used: 3.75 });
      expect(view.videos.short.limit).toBe(20);
      expect(view.videos.short.limitQuarters).toBe(80);
    });

    it('a weekly Starter plan counts 8 quick posts per ISO week (last week does not count)', async () => {
      // Sunday 27 September is in W39: not counted.
      await many(8, 'CAROUSEL', new Date('2026-09-27T09:00:00Z'));
      await many(7, 'CAROUSEL', new Date('2026-09-29T09:00:00Z'));
      const eighth = await project('SLIDESHOW');
      const ok = await checkGenerateQuota(deps(onPlan('starter', 'week')), tenant(), eighth.id);
      expect(ok.reservation?.month).toBe('2026-W40');
      const ninth = await project('SLIDESHOW');
      await expect(
        checkGenerateQuota(deps(onPlan('starter', 'week')), tenant(), ninth.id),
      ).rejects.toBeInstanceOf(QuotaExceededError);
    });

    it('a yearly Starter plan releases 8 videos (32 quick posts) each calendar month', async () => {
      await many(32, 'CAROUSEL', new Date('2026-08-20T09:00:00Z')); // August: not counted
      await many(31, 'CAROUSEL');
      const last = await project('CAROUSEL');
      expect(
        (await checkGenerateQuota(deps(onPlan('starter', 'year')), tenant(), last.id)).violations,
      ).toEqual([]);
      const over = await project('CAROUSEL');
      await expect(
        checkGenerateQuota(deps(onPlan('starter', 'year')), tenant(), over.id),
      ).rejects.toBeInstanceOf(QuotaExceededError);
    });

    it('packs: a quick post takes 1 quarter, an AI video 4; a release gives back exactly that', async () => {
      await many(32, 'CAROUSEL');
      const creditId = await buyPack(); // 5 HD videos = 20 quarters
      expect(await availableCreditQuarters(db, org, new Date(NOW))).toEqual({ short: 20, long: 0 });

      const carousel = await project('CAROUSEL');
      const quick = await checkGenerateQuota(
        deps(onPlan('starter', 'month')),
        tenant(),
        carousel.id,
      );
      expect(quick.reservation?.creditUseId).toEqual(expect.any(String));
      expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 4.75, long: 0 });
      const use = await db.usageCreditUse.findUniqueOrThrow({
        where: { id: quick.reservation?.creditUseId ?? '' },
      });
      expect(use.quarters).toBe(1);

      const video = await project('BRIEF');
      const full = await checkGenerateQuota(deps(onPlan('starter', 'month')), tenant(), video.id);
      expect(await availableCreditQuarters(db, org, new Date(NOW))).toEqual({ short: 15, long: 0 });

      // The video's run never started: its slot and exactly 4 quarters come back.
      await releaseQuotaReservation({ db, logger }, full.reservation);
      expect(
        quotaSlotOf(
          (await db.videoProject.findUniqueOrThrow({ where: { id: video.id } })).metadata,
        ),
      ).toBeNull();
      expect(await availableCreditQuarters(db, org, new Date(NOW))).toEqual({ short: 19, long: 0 });
      const credit = await db.usageCredit.findUniqueOrThrow({ where: { id: creditId } });
      expect(credit).toMatchObject({ quantityQuarters: 20, remainingQuarters: 19 });
      // The legacy video columns are written at purchase only.
      expect(credit).toMatchObject({ quantity: 5, remaining: 5 });
    });

    it('consumeCredit needs the whole post in one pack and records its quarters', async () => {
      await buyPack();
      const ugc = await consumeCredit(db, {
        organisationId: org,
        projectId: `ugc-${org}`,
        month: MONTH,
        kind: 'short',
        now: new Date(NOW),
        quarters: 8,
      });
      expect(ugc).not.toBeNull();
      await consumeCredit(db, {
        organisationId: org,
        projectId: `v-${org}`,
        month: MONTH,
        kind: 'short',
        now: new Date(NOW),
      });
      // 20 − 8 − 4 = 8 quarters: another UGC video (8) fits, then nothing whole is left for a video.
      expect(
        await consumeCredit(db, {
          organisationId: org,
          projectId: `ugc2-${org}`,
          month: MONTH,
          kind: 'short',
          now: new Date(NOW),
          quarters: 8,
        }),
      ).not.toBeNull();
      expect(
        await consumeCredit(db, {
          organisationId: org,
          projectId: `q-${org}`,
          month: MONTH,
          kind: 'short',
          now: new Date(NOW),
          quarters: 1,
        }),
      ).toBeNull();
      const uses = await db.usageCreditUse.findMany({ where: { organisationId: org } });
      expect(uses.map((u) => u.quarters).sort((a, b) => a - b)).toEqual([4, 8, 8]);
    });

    it('a refund counts what spent uses took in quarters', async () => {
      const creditId = await buyPack(); // 20 quarters
      for (let i = 0; i < 3; i += 1)
        await consumeCredit(db, {
          organisationId: org,
          projectId: `q${i}-${org}`,
          month: MONTH,
          kind: 'short',
          now: new Date(NOW),
          quarters: 1,
        });
      const credit = await db.usageCredit.findUniqueOrThrow({ where: { id: creditId } });
      // 40 % refunded = 8 quarters; 3 spent → 20 − 8 − 3 = 9 left (2.25 videos), 8 removed.
      const result = await refundTopUpCredits(
        db,
        {
          id: 'ch',
          paymentIntentId: credit.stripePaymentIntentId,
          customerId: null,
          amount: 1_500,
          amountRefunded: 600,
          refunded: false,
        },
        new Date(NOW),
      );
      expect(result).toMatchObject({ creditId, removed: 2 });
      expect(await availableCredits(db, org, new Date(NOW))).toEqual({ short: 2.25, long: 0 });
    });

    it('the migration backfill is idempotent and converts videos to quarters', async () => {
      const sql = readFileSync(
        join(process.cwd(), 'prisma/migrations/20261011010000_quick_post_quarters/migration.sql'),
        'utf8',
      );
      const statements = sql
        .split(/;\s*\n/)
        .map((s) =>
          s
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n')
            .trim(),
        )
        .filter(Boolean);
      const creditId = await buyPack();
      const ugcProject = await project('BRIEF', new Date(NOW - 60_000), { ugc: { style: 'x' } });
      const use = await consumeCredit(db, {
        organisationId: org,
        projectId: ugcProject.id,
        month: MONTH,
        kind: 'short',
        now: new Date(NOW),
        quarters: 4,
      });
      const rollback = new Error('rollback');
      await expect(
        db.$transaction(
          async (tx) => {
            // Pretend the row was written before 23.3: a pack of 5 with 3 videos left, no quarters.
            await tx.$executeRawUnsafe(
              'ALTER TABLE "studio"."usage_credits" ALTER COLUMN "quantityQuarters" DROP NOT NULL, ALTER COLUMN "remainingQuarters" DROP NOT NULL',
            );
            await tx.$executeRaw`UPDATE "studio"."usage_credits" SET "remaining" = 3, "quantityQuarters" = NULL, "remainingQuarters" = NULL WHERE "id" = ${creditId}`;
            for (let run = 0; run < 2; run += 1)
              for (const statement of statements) await tx.$executeRawUnsafe(statement);
            const row = await tx.usageCredit.findUniqueOrThrow({ where: { id: creditId } });
            expect(row).toMatchObject({ quantityQuarters: 20, remainingQuarters: 12 });
            // A UGC project's earlier use took two videos (8 quarters).
            const after = await tx.usageCreditUse.findUniqueOrThrow({
              where: { id: use?.id ?? '' },
            });
            expect(after.quarters).toBe(8);
            throw rollback;
          },
          { timeout: 30_000 },
        ),
      ).rejects.toBe(rollback);
      // Rolled back: the live row is untouched.
      expect(await db.usageCredit.findUniqueOrThrow({ where: { id: creditId } })).toMatchObject({
        remainingQuarters: 16,
      });
    });
  },
);
