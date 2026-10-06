import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/lib/errors';
import { PLAN_BATCH_SIZE } from '../../src/lib/studio/content-plans/prompt';
import { MAX_PLANNING_OUTPUT_TOKENS } from '../../src/lib/studio/pipeline/token-budgets';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import {
  advanceAutomations,
  MAX_REDRAFT_ATTEMPTS,
  type AutomationRunDeps,
} from '../../src/lib/studio/services/automation-run';
import {
  createAutomation,
  resumeAutomation,
  startAutomation,
} from '../../src/lib/studio/services/automations';
import {
  draftPlan,
  draftPlanFailed,
  titleKey,
  type PlanGenerator,
} from '../../src/lib/studio/services/content-plan-draft';
import { tenant } from '../helpers/api-harness';

// 23.4 on Postgres (production 2026-10-06: an 84-post automation month hit "Output hit
// max_tokens (8000)", was left with untitled posts, and the runner threw "Some posts have no topic
// yet" every five minutes forever): the month drafts in batches, a failed batch is drafted again,
// a period with missing posts heals on the next tick, and repeated failures pause the automation.

const hasDb = Boolean(process.env.DATABASE_URL);
const logger = pino({ level: 'silent' });
const HOUR = 3_600_000;

interface Call {
  count: number;
  maxTokens: number;
  prompt: string;
}

/** A month-plan writer with distinct topics; `fail(n)` makes call n (1-based) throw. */
function writer(fail: (call: number) => boolean = () => false) {
  const calls: Call[] = [];
  const generate: PlanGenerator = async (request) => {
    const count = Number(/Write exactly (\d+) posts/.exec(request.prompt)?.[1] ?? 0);
    calls.push({ count, maxTokens: request.maxTokens, prompt: request.prompt });
    if (fail(calls.length))
      throw new ProviderError('anthropic', 'output_truncated', 'Output hit max_tokens', true);
    const word = () => `w${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    return {
      json: {
        items: Array.from({ length: count }, (_, i) => ({
          index: i + 1,
          title: `${word()} ${word()} ${word()}`,
          brief: 'A short post about our sourdough.',
          hook: `${word()} ${word()}`,
          points: ['Baked at dawn', 'Local flour'],
          cta: 'Order today',
          caption: 'Fresh bread',
          hashtags: ['bread'],
        })),
      },
      model: 'fake',
    };
  };
  return { generate, calls };
}

const slotLines = (prompt: string) =>
  [...prompt.matchAll(/^\d+\. .*$/gm)].map((m) => m[0]).join('\n');

/** A writer whose second batch always fails (also when it is drafted again). */
function secondBatchFails() {
  let bad: string | null = null;
  let calls = 0;
  const inner = writer();
  const generate: PlanGenerator = async (request) => {
    calls += 1;
    const slots = slotLines(request.prompt);
    if (calls === 2) bad = slots;
    if (bad !== null && slots === bad)
      throw new ProviderError('anthropic', 'output_truncated', 'Output hit max_tokens', true);
    return inner.generate(request);
  };
  return { generate };
}

describe.skipIf(!hasDb)('23.4 month plans in batches', { timeout: 240_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `db-p23b-${randomUUID()}`;
  const owner = { ...tenant(org), organisation: { id: org, planTier: 'STANDARD' } };
  let biz: string;
  let queue: InlineJobQueue;
  let audits: Array<{ action: string; metadata?: Record<string, unknown> }>;
  const deps = () => ({
    db,
    queue,
    now: Date.now,
    logger,
    registry: undefined as never,
    audit: (e: { action: string }) => audits.push(e),
  });
  const runDeps = (
    gen: PlanGenerator,
    extra: Partial<AutomationRunDeps> = {},
  ): AutomationRunDeps => ({
    db,
    queue,
    logger,
    now: Date.now,
    killSwitch: { check: async () => ({ killed: false }) },
    generator: () => gen,
    audit: (e) => audits.push(e),
    ...extra,
  });
  const create = (over: Record<string, unknown> = {}) =>
    createAutomation(deps(), owner, {
      businessId: biz,
      cadence: { mode: 'per_day', postsPerDay: 3 },
      duration: 'one_week',
      platforms: ['tiktok', 'instagram_feed'],
      targets: [],
      approvalMode: 'auto',
      ...over,
    } as never);

  const draftJobs = () => queue.pending.filter((j) => j.name === 'draft-content-plan');
  /** Run the last queued background draft. */
  const runDraft = async (gen: PlanGenerator) => {
    const data = draftJobs().at(-1)!.data as { planId: string; runId: string };
    await draftPlan({ db, generate: gen, logger, now: Date.now }, data.planId, data.runId);
    return data.planId;
  };
  const planned = (planId: string) =>
    db.contentPlanItem.findMany({
      where: { planId, status: 'PLANNED' },
      orderBy: [{ slotAt: 'asc' }, { position: 'asc' }],
    });
  const untitled = async (planId: string) =>
    (await planned(planId)).filter((i) => !i.title || !i.brief).length;

  /** A started automation whose period draft left `failBatch`'s posts unwritten (last attempt). */
  async function brokenPeriod() {
    const a = await create();
    const { automation } = await startAutomation(deps(), owner, a.id);
    const planId = automation.currentPlanId!;
    // 21 posts = batches of 10, 10, 1; the second batch fails in both passes.
    const bad = secondBatchFails();
    await expect(runDraft(bad.generate)).rejects.toBeInstanceOf(ProviderError);
    // Still drafting after a failed attempt; the job's last attempt makes it a DRAFT that says so.
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'DRAFTING',
    );
    await draftPlanFailed(db, planId, 'draft_failed');
    return { a, planId };
  }

  beforeEach(async () => {
    queue = new InlineJobQueue();
    audits = [];
    await db.contentPlan.updateMany({
      where: { organisationId: org, status: 'GENERATING' },
      data: { status: 'COMPLETED' },
    });
    biz = `biz-${randomUUID().slice(0, 8)}`;
    await db.business.create({
      data: { id: biz, organisationId: org, name: `Sourdough ${biz}`, createdByUserId: 'user-1' },
    });
  });

  afterAll(async () => {
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.contentPlan.deleteMany({ where: { organisationId: org } });
    await db.automation.deleteMany({ where: { organisationId: org } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.business.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('a four-week, 3-a-day month drafts in batches with the planning cap and unique topics', async () => {
    const a = await create({ duration: 'four_weeks' });
    const { automation } = await startAutomation(deps(), owner, a.id);
    const planId = automation.currentPlanId!;
    const plan = await db.contentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.requestedCount).toBeGreaterThan(70);
    const todo = await untitled(planId);
    const w = writer();
    await runDraft(w.generate);
    expect(w.calls.length).toBe(Math.ceil(todo / PLAN_BATCH_SIZE));
    for (const c of w.calls) {
      expect(c.count).toBeLessThanOrEqual(PLAN_BATCH_SIZE);
      expect(c.maxTokens).toBe(MAX_PLANNING_OUTPUT_TOKENS);
      // Each batch is numbered from 1.
      expect(c.prompt).toMatch(/\n1\. .* — /);
    }
    const after = await db.contentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.status).toBe('DRAFT');
    expect(after.draftError).toBeNull();
    const items = await planned(planId);
    expect(items.every((i) => i.title && i.brief)).toBe(true);
    expect(new Set(items.map((i) => titleKey(i.title))).size).toBe(items.length);
    await db.automation.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
  });

  it('a retried draft job writes only the posts still missing', async () => {
    const a = await create();
    const { automation } = await startAutomation(deps(), owner, a.id);
    const planId = automation.currentPlanId!;
    const bad = secondBatchFails();
    await expect(runDraft(bad.generate)).rejects.toBeInstanceOf(ProviderError);
    const missing = await untitled(planId);
    expect(missing).toBe(10);
    const before = new Map((await planned(planId)).map((i) => [i.id, i.title]));
    const good = writer();
    await runDraft(good.generate);
    expect(good.calls.map((c) => c.count)).toEqual([10]);
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'DRAFT',
    );
    // Posts written by the first attempt are untouched.
    for (const item of await planned(planId))
      if (before.get(item.id)) expect(item.title).toBe(before.get(item.id));
    await db.automation.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
  });

  it('a period left with missing posts heals on the next tick and activates', async () => {
    const { a, planId } = await brokenPeriod();
    expect(await untitled(planId)).toBe(10);
    const jobsBefore = draftJobs().length;

    const tick = await advanceAutomations(runDeps(writer().generate), { automationId: a.id });
    expect(tick.activated).toBe(0);
    const plan = await db.contentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('DRAFTING');
    expect(plan.draftError).toBeNull();
    expect(plan.metadata).toMatchObject({ redraftAttempts: 1 });
    expect(draftJobs()).toHaveLength(jobsBefore + 1);
    expect(audits.some((e) => e.action === 'studio.automation.redraft')).toBe(true);

    const good = writer();
    await runDraft(good.generate);
    expect(good.calls.map((c) => c.count)).toEqual([10]);
    const healed = await advanceAutomations(runDeps(good.generate), { automationId: a.id });
    expect(healed.activated).toBe(1);
    expect((await db.automation.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('ACTIVE');
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'GENERATING',
    );
  });

  it(`pauses with draft_failed after ${MAX_REDRAFT_ATTEMPTS} failed drafts (no endless loop)`, async () => {
    const { a, planId } = await brokenPeriod();
    const failing = writer(() => true);
    for (let attempt = 1; attempt <= MAX_REDRAFT_ATTEMPTS; attempt += 1) {
      const r = await advanceAutomations(runDeps(failing.generate), { automationId: a.id });
      expect(r.paused).toBe(0);
      await expect(runDraft(failing.generate)).rejects.toBeInstanceOf(ProviderError);
      await draftPlanFailed(db, planId, 'draft_failed');
    }
    const r = await advanceAutomations(runDeps(failing.generate), { automationId: a.id });
    expect(r.paused).toBe(1);
    const paused = await db.automation.findUniqueOrThrow({ where: { id: a.id } });
    expect(paused.status).toBe('PAUSED');
    expect(paused.pauseReason).toBe('draft_failed');
    expect(
      await db.notification.count({ where: { organisationId: org, link: `/automations/${a.id}` } }),
    ).toBe(1);
    expect(audits.filter((e) => e.action === 'studio.automation.redraft')).toHaveLength(
      MAX_REDRAFT_ATTEMPTS,
    );
    // Paused: later ticks do nothing more.
    const jobs = draftJobs().length;
    const again = await advanceAutomations(runDeps(failing.generate), { automationId: a.id });
    expect(again.automations).toBe(0);
    expect(draftJobs()).toHaveLength(jobs);

    // Resuming gives the period its attempts again; the next tick drafts the missing posts.
    const resumed = await resumeAutomation(deps(), owner, a.id);
    expect(resumed.status).toBe('GENERATING');
    expect(
      (await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).metadata,
    ).toMatchObject({ redraftAttempts: 0 });
    await advanceAutomations(runDeps(failing.generate), { automationId: a.id });
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'DRAFTING',
    );
    await db.automation.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
  });

  it('a draft job lost while DRAFTING is queued again once stale', async () => {
    const a = await create();
    const { automation } = await startAutomation(deps(), owner, a.id);
    const planId = automation.currentPlanId!;
    const first = (await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).metadata as {
      draftRunId: string;
    };
    const soon = await advanceAutomations(runDeps(writer().generate), { automationId: a.id });
    expect(soon.automations).toBe(1);
    expect(draftJobs()).toHaveLength(1);
    const later = () => Date.now() + 2 * HOUR;
    await advanceAutomations(runDeps(writer().generate, { now: later }), { automationId: a.id });
    const plan = await db.contentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('DRAFTING');
    expect((plan.metadata as { draftRunId: string }).draftRunId).not.toBe(first.draftRunId);
    expect(draftJobs()).toHaveLength(2);
    await runDraft(writer().generate);
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'DRAFT',
    );
    await db.automation.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
  });
});
