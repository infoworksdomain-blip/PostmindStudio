import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import { createAngle } from '../../src/lib/studio/services/angles';
import { approveReview, decideSlot } from '../../src/lib/studio/services/automation-actions';
import {
  advanceAutomations,
  type AutomationRunDeps,
} from '../../src/lib/studio/services/automation-run';
import {
  createAutomation,
  pauseAutomation,
  resumeAutomation,
  startAutomation,
} from '../../src/lib/studio/services/automations';
import { putMix } from '../../src/lib/studio/services/content-mix';
import { draftPlan, type PlanGenerator } from '../../src/lib/studio/services/content-plan-draft';
import { tenant } from '../helpers/api-harness';

// 22.5 automations on Postgres: start (mix snapshot, cheapest formats, YouTube / TikTok rules),
// the background draft, the runner (review vs auto, duplicates, rollover, allowance pause), slot
// review, approve, pause / resume.

const hasDb = Boolean(process.env.DATABASE_URL);
const logger = pino({ level: 'silent' });
const DAY = 86_400_000;

/** A month-plan writer that gives every slot a distinct topic (and records the prompts). */
function writer(): PlanGenerator & { prompts: string[] } {
  const fn = (async (request) => {
    fn.prompts.push(request.prompt);
    const count = Number(/Write exactly (\d+) posts/.exec(request.prompt)?.[1] ?? 0);
    const word = () => `w${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    return {
      json: {
        items: Array.from({ length: count }, (_, i) => ({
          index: i + 1,
          title: `${word()} ${word()} ${word()}`,
          brief: 'A short post about our sourdough.',
          hook: `${word()} ${word()}`,
          points: ['Baked at dawn', 'Local flour', 'Delivered weekly'],
          cta: 'Order today',
          caption: 'Fresh bread',
          hashtags: ['bread'],
        })),
      },
      model: 'fake',
    };
  }) as PlanGenerator & { prompts: string[] };
  fn.prompts = [];
  return fn;
}

describe.skipIf(!hasDb)('22.5 automations', { timeout: 240_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `db-p22a-${randomUUID()}`;
  const owner = { ...tenant(org), organisation: { id: org, planTier: 'STANDARD' } };
  let biz: string;
  let queue: InlineJobQueue;
  let audits: Array<{ action: string }>;
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
      cadence: { mode: 'per_day', postsPerDay: 1 },
      duration: 'one_week',
      platforms: ['tiktok', 'youtube_short', 'instagram_feed'],
      targets: [],
      approvalMode: 'review',
      ...over,
    } as never);

  /** Run the background draft the start enqueued. */
  const runDraft = async (gen: PlanGenerator) => {
    const job = queue.pending.filter((j) => j.name === 'draft-content-plan').at(-1);
    const data = job!.data as { planId: string; runId: string };
    await draftPlan({ db, generate: gen, logger, now: Date.now }, data.planId, data.runId);
    return data.planId;
  };

  beforeEach(async () => {
    queue = new InlineJobQueue();
    audits = [];
    // generatePlan allows 3 generating plans per organisation; earlier tests' plans are done.
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
    await db.contentAngle.deleteMany({ where: { organisationId: org } });
    await db.contentMixPreference.deleteMany({ where: { organisationId: org } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.business.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('start: snapshots the mix and lays out a week of cheap formats with angles', async () => {
    await createAngle(db, { organisationId: org, businessId: biz }, 'user-1', {
      title: 'Starter care',
      description: 'Keeping a starter alive',
      targetAudience: 'home bakers',
      weight: 50,
    });
    const a = await create();
    expect(a.status).toBe('DRAFT');
    const { automation } = await startAutomation(deps(), owner, a.id);
    expect(automation.status).toBe('GENERATING');
    expect(automation.mixSnapshot).toMatchObject({
      formatWeights: { carousel: 35, slideshow: 35 },
    });
    const plan = await db.contentPlan.findFirstOrThrow({
      where: { id: automation.currentPlanId! },
      include: { items: true },
    });
    expect(plan.automationId).toBe(a.id);
    expect(plan.status).toBe('DRAFTING');
    const formats = new Set(plan.items.map((i) => i.format));
    // Only the cheap formats (paid ones are 0 by default). 22.2: a wall of text is cheap too; a
    // hook + demo needs a demo video and a library hook clip, which this business has not got.
    expect(
      [...formats].every((f) => f === 'carousel' || f === 'slideshow' || f === 'wall_of_text'),
    ).toBe(true);
    expect(formats.has('hook_demo')).toBe(false);
    expect(plan.items.every((i) => i.angle.startsWith('Starter care'))).toBe(true);
    expect(queue.pending.some((j) => j.name === 'draft-content-plan')).toBe(true);
    // The writer is told the angle.
    const gen = writer();
    await runDraft(gen);
    expect(gen.prompts[0]).toContain(
      'angle: Starter care — Keeping a starter alive (for home bakers)',
    );
  });

  it('review mode: DRAFT → REVIEW (notified), slot review, approve → ACTIVE with format-aware projects', async () => {
    const a = await create();
    await startAutomation(deps(), owner, a.id);
    const gen = writer();
    const planId = await runDraft(gen);
    const r1 = await advanceAutomations(runDeps(gen), { automationId: a.id });
    expect(r1.review).toBe(1);
    expect((await db.automation.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('REVIEW');
    expect(
      await db.notification.count({ where: { organisationId: org, link: `/automations/${a.id}` } }),
    ).toBe(1);

    const items = await db.contentPlanItem.findMany({
      where: { planId },
      orderBy: { slotAt: 'asc' },
    });
    const detail = await decideSlot({ ...deps(), generate: gen }, org, a.id, items[0]!.id, 'skip');
    expect(detail.periods[0]!.items.some((i) => i.id === items[0]!.id)).toBe(false);
    await decideSlot({ ...deps(), generate: gen }, org, a.id, items[1]!.id, 'keep');

    await approveReview(deps(), owner, a.id);
    expect((await db.automation.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('ACTIVE');
    expect(audits.some((e) => e.action === 'studio.automation.activate')).toBe(true);
    const plan = await db.contentPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { items: true },
    });
    expect(plan.status).toBe('GENERATING');
    const projects = await db.videoProject.findMany({
      where: { id: { in: plan.items.flatMap((i) => (i.projectId ? [i.projectId] : [])) } },
    });
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      const platforms = (p.targetFormats as Array<{ platform: string }>).map((f) => f.platform);
      // Fastlane: YouTube gets no slideshows or carousels.
      expect(platforms).not.toContain('youtube_short');
      if (p.sourceType === 'SLIDESHOW') {
        const slides = await db.slideshowSlide.findMany({
          where: { projectId: p.id },
          orderBy: { sortOrder: 'asc' },
        });
        // Hook and closing slides are photos with dimmed headline text, not flat cards.
        expect(slides[0]?.slideType).toBe('IMAGE_STILL');
        expect((slides[0]?.metadata as { headline?: boolean }).headline).toBe(true);
      }
    }
  });

  it('auto mode goes straight to ACTIVE; pause holds the plan, resume releases it', async () => {
    const a = await create({ approvalMode: 'auto' });
    await startAutomation(deps(), owner, a.id);
    const gen = writer();
    const planId = await runDraft(gen);
    const r = await advanceAutomations(runDeps(gen), { automationId: a.id });
    expect(r.activated).toBe(1);
    const paused = await pauseAutomation(deps(), org, a.id);
    expect(paused.status).toBe('PAUSED');
    expect(
      (await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).metadata,
    ).toMatchObject({ paused: true });
    const resumed = await resumeAutomation(deps(), owner, a.id);
    expect(resumed.status).toBe('ACTIVE');
    expect(
      (await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).metadata,
    ).toMatchObject({ paused: false });
  });

  it('duplicates of recent posts are rewritten, then dropped as no_unique_content', async () => {
    const a = await create({ approvalMode: 'review' });
    await startAutomation(deps(), owner, a.id);
    // A writer that always repeats the same topic.
    const same = (async (request) => {
      const count = Number(/Write exactly (\d+) posts/.exec(request.prompt)?.[1] ?? 0);
      return {
        json: {
          items: Array.from({ length: count }, (_, i) => ({
            index: i + 1,
            title: 'Why sourdough needs patience',
            brief: 'b',
            hook: 'Patience makes sourdough',
            points: ['a', 'b', 'c'],
            cta: '',
          })),
        },
        model: 'fake',
      };
    }) as PlanGenerator;
    const planId = await runDraft(same);
    await advanceAutomations(runDeps(same), { automationId: a.id });
    const items = await db.contentPlanItem.findMany({ where: { planId } });
    const live = items.filter((i) => i.status === 'PLANNED');
    const dupes = items.filter((i) => i.statusReason === 'no_unique_content');
    expect(live).toHaveLength(1);
    expect(dupes.length).toBe(items.length - 1);
  });

  it('ongoing: drafts the next period before this one ends; pauses when the allowance is used up', async () => {
    const a = await create({ duration: 'ongoing_weekly', approvalMode: 'auto' });
    await startAutomation(deps(), owner, a.id);
    const gen = writer();
    const planId = await runDraft(gen);
    await advanceAutomations(runDeps(gen), { automationId: a.id });
    // A day before the period ends: inside the lead time.
    const end = (await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).windowEnd;
    const later = () => end.getTime() - DAY;
    const r = await advanceAutomations(runDeps(gen, { now: later }), { automationId: a.id });
    expect(r.rolledOver).toBe(1);
    const next = await db.automation.findUniqueOrThrow({ where: { id: a.id } });
    expect(next.status).toBe('GENERATING');
    expect(next.periodIndex).toBe(2);
    expect(next.currentPlanId).not.toBe(planId);

    // Second automation: the allowance is used up at rollover → PAUSED with a notification.
    const b = await create({ duration: 'ongoing_weekly', approvalMode: 'auto' });
    await startAutomation(deps(), owner, b.id);
    const planB = await runDraft(gen);
    await advanceAutomations(runDeps(gen), { automationId: b.id });
    const endB = (await db.contentPlan.findUniqueOrThrow({ where: { id: planB } })).windowEnd;
    const none = {
      forOrganisation: async () => ({
        tier: 'STANDARD',
        access: 'full',
        source: 'stripe',
        limits: { seats: 5, businesses: 1, storageGb: 25 },
        custom: { shortVideos: 0 },
      }),
      invalidate: () => undefined,
    };
    const paused = await advanceAutomations(
      runDeps(gen, { entitlements: none as never, now: () => endB.getTime() - DAY }),
      {
        automationId: b.id,
      },
    );
    expect(paused.paused).toBe(1);
    expect((await db.automation.findUniqueOrThrow({ where: { id: b.id } })).pauseReason).toBe(
      'allowance',
    );
  });

  it('paid formats are only used once the owner raises their weight', async () => {
    await putMix(db, { organisationId: org, businessId: biz }, 'user-1', {
      formatWeights: { carousel: 0, slideshow: 0, ai_video: 100 },
    });
    const a = await create({ platforms: ['youtube_short'] });
    const { automation } = await startAutomation(deps(), owner, a.id);
    const items = await db.contentPlanItem.findMany({
      where: { planId: automation.currentPlanId! },
    });
    expect(items.every((i) => i.format === 'ai_video' && i.kind === 'VIDEO')).toBe(true);
    // Only YouTube and only cheap formats switched on: nothing can be made there.
    await putMix(db, { organisationId: org, businessId: biz }, 'user-1', {
      formatWeights: { carousel: 35, slideshow: 35, ai_video: 0 },
    });
    const b = await create({ platforms: ['youtube_short'] });
    await expect(startAutomation(deps(), owner, b.id)).rejects.toThrow(
      /formats in your content mix/,
    );
  });
});
