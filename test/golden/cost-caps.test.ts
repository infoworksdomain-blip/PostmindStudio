import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import * as listNotificationsRoute from '../../src/app/api/studio/notifications/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { CostCaps } from '../../src/lib/studio/cost/caps';
import { createCostGuard } from '../../src/lib/studio/cost/guard';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import type { OutboundNotification } from '../../src/lib/studio/notifications/sender';
import { getMetrics } from '../../src/lib/studio/observability/metrics';
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

// Phase 12 (spec 12.5 / 14.4) — cost caps and alerting end to end: real routes, real workers on
// the inline queue, real Postgres, scripted providers (planning 1p per Claude call, Runway 45p a
// clip, ElevenLabs 1p a line, Shotstack 30p, Hive 1p: ~127p for the harness's 3-shot brief).
//
//   CC-01  A project pauses at 90% of its budget with a notification, then continues after the
//          budget is raised (PATCH /projects/:id) and the project is regenerated.
//   CC-02  The organisation's daily cap pauses generation, but a publication of an already
//          generated video still goes out.
//   CC-03  An 80% alert fires exactly once however many provider calls follow it.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Item = { kind: string; title: string; body: string; link: string | null };

describe.skipIf(!hasDb)('golden journeys: cost caps + alerting', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  /** A journey whose provider router has the production cost guard and a recording webhook. */
  function guardedJourney(id: string, caps: CostCaps = { orgDailyPenceByTier: {} }) {
    const j = startJourney(db, id);
    const logger = pino({ level: 'silent' });
    const sent: OutboundNotification[] = [];
    const notifier = createNotifier({
      db,
      logger,
      sender: { send: async (n) => void sent.push(n) },
    });
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
    return { j, sent, caps };
  }

  // As the journey's reader (installApi of the latest journey owns the tokens).
  const notifications = async () => {
    const res = await call(listNotificationsRoute.GET, { token: 'reader' });
    expect(res.status).toBe(200);
    return res.json.data as Item[];
  };
  const alertsFor = (org: string) =>
    db.costAlert.findMany({ where: { organisationId: org }, orderBy: { createdAt: 'asc' } });

  it('CC-01 a project pauses at 90% with a notification and resumes after the budget is raised', async () => {
    const { j, sent } = guardedJourney('cc01');
    const id = await createProject(j, briefBody({ costBudgetPence: 100 }));

    const paused = await generate(j, id, { expectClean: false });
    expect(paused.state).toBe('FAILED');
    expect(paused.errorReason).toMatch(/^cost_cap_paused: project reached 90% of its budget/);
    // Planning (3p) + two clips (90p) + one voice line: the second clip took it past 90%, and
    // nothing ran after that.
    expect(paused.costActualPence).toBeGreaterThanOrEqual(90);
    expect(paused.costActualPence).toBeLessThanOrEqual(100);
    expect(j.h.adapters.runway.requests).toHaveLength(2);
    expect(j.h.adapters.shotstack.requests).toHaveLength(0);

    expect((await alertsFor(j.org)).map((a) => [a.scope, a.threshold, a.period])).toEqual([
      ['PROJECT', 80, 'budget:100'],
      ['PROJECT', 90, 'budget:100'],
    ]);
    const inbox = await notifications();
    expect(inbox.map((n) => n.kind).sort()).toEqual(['cost_alert', 'cost_paused']);
    expect(inbox.find((n) => n.kind === 'cost_paused')).toMatchObject({
      link: `/projects/${id}`,
      title: 'Generation paused: “Leeds Sourdough launch” reached 90% of its budget',
    });
    expect(sent.map((s) => s.kind).sort()).toEqual(['cost_alert', 'cost_paused']);
    expect(j.h.audits.filter((a) => a.action === 'studio.cost.alert')).toHaveLength(2);

    // The user raises the budget (PATCH works on a FAILED project) and regenerates.
    const patched = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id },
      body: { costBudgetPence: 1_000 },
    });
    expect(patched.status).toBe(200);
    const resumed = await generate(j, id);
    expect(resumed.state).toBe('READY_FOR_REVIEW');
    expect(resumed.errorReason).toBeNull();
    // ~94p + ~127p of 1000p: below 80% of the new budget, so no new alert.
    expect(resumed.costActualPence).toBeLessThan(800);
    expect(await alertsFor(j.org)).toHaveLength(2);
    expect((await notifications()).map((n) => n.kind)).toContain('generation_complete');
  });

  it('CC-02 the organisation daily cap pauses generation but a publish still goes out', async () => {
    const { j, caps } = guardedJourney('cc02');
    // Under the cap: generate and approve a video.
    const ready = await createProject(j);
    expect((await generate(j, ready)).state).toBe('READY_FOR_REVIEW');
    await approve(j, ready);
    const [render] = await rendersOf(j, ready);

    // Product sets the STANDARD tier's daily cap below today's spend (tenant tier: STANDARD).
    caps.orgDailyPenceByTier.STANDARD = 100;
    const blocked = await createProject(j);
    const paused = await generate(j, blocked, { expectClean: false });
    expect(paused.state).toBe('FAILED');
    expect(paused.errorReason).toMatch(/^cost_cap_paused: organisation daily cost cap reached/);
    expect(paused.costActualPence).toBe(0); // refused before the first provider call

    const orgAlerts = (await alertsFor(j.org)).filter((a) => a.scope === 'ORG_DAILY');
    expect(orgAlerts.map((a) => a.threshold)).toEqual([80, 100]);
    const orgWide = (await notifications()).find((n) => n.kind === 'cost_paused');
    expect(orgWide?.body).toContain('publishing is not affected');
    expect(
      await db.notification.findFirst({ where: { organisationId: j.org, kind: 'cost_paused' } }),
    ).toMatchObject({ userId: null });

    // Publishing the already-generated video is not generation: it still goes out.
    const conn = await connect(j, 'tiktok');
    const pubId = await publish(j, {
      renderId: render?.id,
      platform: 'tiktok',
      connectionId: conn.id,
    });
    await drain(j);
    expect(await getPublication(j, pubId)).toMatchObject({ state: 'PUBLISHED' });
    expect(j.h.publishers.tiktok.published).toHaveLength(1);
  });

  it('CC-03 the 80% alert fires exactly once', async () => {
    // ~127p of generation against a 140p STANDARD cap: crosses 80% (112p) mid-run, never 100%.
    const { j, sent } = guardedJourney('cc03', { orgDailyPenceByTier: { STANDARD: 140 } });
    const metric = async () =>
      (await getMetrics().costAlerts.get()).values.find(
        (v) => v.labels.scope === 'org_daily' && v.labels.threshold === '80',
      )?.value ?? 0;
    const before = await metric();

    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const providerCalls = await db.providerJob.count({ where: { organisationId: j.org } });
    expect(providerCalls).toBeGreaterThan(5);

    const alerts = await alertsFor(j.org);
    expect(alerts.map((a) => [a.scope, a.threshold, a.capPence])).toEqual([['ORG_DAILY', 80, 140]]);
    expect(alerts[0]?.spentPence).toBeGreaterThanOrEqual(112);
    expect(await metric()).toBe(before + 1);
    const costNotes = (await notifications()).filter((n) => n.kind.startsWith('cost_'));
    expect(costNotes).toEqual([
      expect.objectContaining({
        kind: 'cost_alert',
        title: '80% of today’s generation budget used',
      }),
    ]);
    expect(sent.filter((s) => s.kind === 'cost_alert')).toHaveLength(1);
    expect(j.h.audits.filter((a) => a.action === 'studio.cost.alert')).toHaveLength(1);
  });
});
