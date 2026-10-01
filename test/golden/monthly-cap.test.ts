import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import * as listNotificationsRoute from '../../src/app/api/studio/notifications/route';
import * as duplicateRoute from '../../src/app/api/studio/projects/[id]/duplicate/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { costCapsFromEnv, utcMonthRange } from '../../src/lib/studio/cost/caps';
import { createCostGuard } from '../../src/lib/studio/cost/guard';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import { getMetrics } from '../../src/lib/studio/observability/metrics';
import { INTRODUCE_YOURSELF } from '../../src/lib/studio/templates/seed';
import { createPrismaBudgetChecker } from '../../src/lib/studio/providers/budget';
import { call } from '../helpers/api-harness';
import {
  approve,
  briefBody,
  cleanupGolden,
  connect,
  createProject,
  drain,
  generate,
  getPublication,
  publish,
  rendersOf,
  startJourney,
} from './journey-kit';

// Operator decision 2 (2026-09-27) end to end: the production cap defaults (costCapsFromEnv
// with no overrides except the daily cap, disabled with "none" so the month is what binds),
// real routes, real workers on the inline queue, real Postgres, scripted providers (~127p for
// the harness's 3-shot brief).
//
//   MC-01  A project created without a budget gets the £3.50 short-form default; a YouTube
//          long-form one (directly or from a template) gets £30; an explicit budget wins and is
//          kept by duplicate; a pre-existing project without a budget is left alone.
//   MC-02  Month-to-date spend crosses 80% of the STANDARD monthly cap (£73) during a run:
//          one ORG_MONTHLY alert (period YYYY-MM) and one org-wide notification.
//   MC-03  At 100% generation pauses as cost_cap_paused (org monthly), while publishing an
//          already generated video still goes out.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;
const STANDARD_MONTHLY = 7_300;

type Item = { kind: string; title: string; body: string; link: string | null };

describe.skipIf(!hasDb)(
  'golden journeys: monthly cost cap + default budgets',
  { timeout: 120_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();

    afterAll(async () => {
      setApiDeps(undefined);
      await cleanupGolden(db, since);
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    function guardedJourney(id: string) {
      const j = startJourney(db, id);
      const caps = costCapsFromEnv({ STUDIO_ORG_DAILY_CAP_PENCE_STANDARD: 'none' });
      const logger = pino({ level: 'silent' });
      const notifier = createNotifier({ db, logger, sender: { send: async () => undefined } });
      const guard = createCostGuard({
        db,
        caps,
        notifier,
        audit: (entry) => j.h.audits.push(entry),
        logger,
        metrics: getMetrics(),
      });
      j.h.deps.budget = createPrismaBudgetChecker(db, { guard });
      j.h.deps.notifier = notifier;
      return { j, caps };
    }

    /** Spend recorded earlier this month (first day of the UTC month) by another provider. */
    async function seedMonthToDate(org: string, pence: number) {
      await db.providerUsage.upsert({
        where: {
          organisationId_provider_day: {
            organisationId: org,
            provider: 'seed-earlier',
            day: utcMonthRange(new Date()).start,
          },
        },
        create: {
          organisationId: org,
          provider: 'seed-earlier',
          day: utcMonthRange(new Date()).start,
          jobCount: 1,
          costPence: pence,
        },
        update: { costPence: pence },
      });
    }

    const notifications = async () => {
      const res = await call(listNotificationsRoute.GET, { token: 'reader' });
      expect(res.status).toBe(200);
      return res.json.data as Item[];
    };
    const monthlyAlerts = (org: string) =>
      db.costAlert.findMany({
        where: { organisationId: org, scope: 'ORG_MONTHLY' },
        orderBy: { threshold: 'asc' },
      });
    const budgetOf = async (id: string) =>
      (await db.videoProject.findUniqueOrThrow({ where: { id } })).costBudgetPence;

    it('MC-01 projects without a budget get the short-form / long-form default', async () => {
      const { j } = guardedJourney('mc01');
      const short = await createProject(j);
      expect(await budgetOf(short)).toBe(350);

      const long = await createProject(
        j,
        briefBody({
          targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', durationSec: 300 }],
        }),
      );
      expect(await budgetOf(long)).toBe(3_000);

      const explicit = await createProject(j, briefBody({ costBudgetPence: 1_234 }));
      expect(await budgetOf(explicit)).toBe(1_234);
      const copy = await call(duplicateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: explicit },
      });
      expect(copy.status).toBe(201);
      expect((copy.json.project as { costBudgetPence: number }).costBudgetPence).toBe(1_234);

      // A TEMPLATE project takes its formats (here long-form YouTube) from the template.
      const template = await db.template.create({
        data: {
          organisationId: j.org,
          name: 'Long explainer',
          category: 'custom',
          targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', duration: 300 }],
          scriptTemplate: '{{brief}}',
          shotBlueprint: INTRODUCE_YOURSELF.shotBlueprint as never,
        },
      });
      try {
        const fromTemplate = await createProject(j, {
          name: 'From template',
          businessId: 'biz-golden',
          sourceType: 'TEMPLATE',
          templateId: template.id,
          brief: { rawInput: 'Explain our subscription' },
        });
        expect(await budgetOf(fromTemplate)).toBe(3_000);
        await db.videoProject.delete({ where: { id: fromTemplate } });
      } finally {
        await db.template.delete({ where: { id: template.id } });
      }

      // A project from before the defaults (no budget) is left alone; its duplicate gets one.
      const legacy = await db.videoProject.create({
        data: {
          organisationId: j.org,
          businessId: 'biz-golden',
          createdByUserId: 'legacy-user',
          name: 'Legacy long-form',
          state: 'DRAFT',
          sourceType: 'BRIEF',
          targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', duration: 600 }],
        },
      });
      expect(legacy.costBudgetPence).toBeNull();
      const legacyCopy = await call(duplicateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: legacy.id },
      });
      expect(legacyCopy.status).toBe(201);
      expect((legacyCopy.json.project as { costBudgetPence: number }).costBudgetPence).toBe(3_000);
      expect(await budgetOf(legacy.id)).toBeNull();
    });

    it('MC-02 the monthly 80% alert fires once during a run; generation completes', async () => {
      const { j } = guardedJourney('mc02');
      // 5,790p this month + ~127p of generation crosses 5,840p (80% of £73) mid-run.
      await seedMonthToDate(j.org, 5_790);
      const id = await createProject(j);
      const done = await generate(j, id);
      expect(done.state).toBe('READY_FOR_REVIEW');

      const alerts = await monthlyAlerts(j.org);
      const month = new Date().toISOString().slice(0, 7);
      expect(alerts.map((a) => [a.threshold, a.period, a.capPence])).toEqual([
        [80, month, STANDARD_MONTHLY],
      ]);
      const costNotes = (await notifications()).filter((n) => n.kind.startsWith('cost_'));
      expect(costNotes).toEqual([
        expect.objectContaining({
          kind: 'cost_alert',
          title: '80% of this month’s generation budget used',
          link: '/analytics',
        }),
      ]);
    });

    it('MC-03 at 100% of the monthly cap generation pauses but publishing continues', async () => {
      const { j } = guardedJourney('mc03');
      const ready = await createProject(j);
      expect((await generate(j, ready)).state).toBe('READY_FOR_REVIEW');
      await approve(j, ready);
      const [render] = await rendersOf(j, ready);

      await seedMonthToDate(j.org, STANDARD_MONTHLY);
      const blocked = await createProject(j);
      const paused = await generate(j, blocked, { expectClean: false });
      expect(paused.state).toBe('FAILED');
      // The customer's API view carries the reason code only (failure-presenter.ts).
      expect(paused.errorReason).toBe('cost_cap_paused');
      expect(paused.costActualPence).toBe(0); // refused before the first provider call

      expect((await monthlyAlerts(j.org)).map((a) => a.threshold)).toEqual([80, 100]);
      const pausedNote = (await notifications()).find((n) => n.kind === 'cost_paused');
      expect(pausedNote?.title).toBe('Generation paused: this month’s generation budget is spent');
      expect(pausedNote?.body).toContain('publishing is not affected');
      expect(
        await db.notification.findFirst({ where: { organisationId: j.org, kind: 'cost_paused' } }),
      ).toMatchObject({ userId: null });

      const conn = await connect(j, 'tiktok');
      const pubId = await publish(j, {
        renderId: render?.id,
        platform: 'tiktok',
        connectionId: conn.id,
      });
      await drain(j);
      expect(await getPublication(j, pubId)).toMatchObject({ state: 'PUBLISHED' });
    });
  },
);
