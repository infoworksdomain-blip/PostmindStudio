import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as generatePlanRoute from '../../src/app/api/studio/content-plans/[id]/generate/route';
import * as planRoute from '../../src/app/api/studio/content-plans/[id]/route';
import * as itemRoute from '../../src/app/api/studio/content-plans/[id]/items/[itemId]/route';
import * as plansRoute from '../../src/app/api/studio/content-plans/route';
import * as upcomingRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/upcoming/route';
import { createMemoryAuthMailer } from '../../src/lib/email/auth-mailer';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { advanceContentPlans } from '../../src/lib/studio/services/content-plan-run';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { ALL_CAPABILITIES, call, tenant } from '../helpers/api-harness';
import { BUSINESS_ID, cleanupGolden, connect, drain, startJourney } from './journey-kit';

// 20.9 golden — "Plan my month" end to end on a small plan: 3 days × 2 posts a day, half videos
// and half slideshows. Draft (Claude writes the topics) → "Generate and schedule" → the runner
// starts at most 2 at a time → every item goes through the real pipeline (videos via the 9 layers,
// slideshows via the slideshow flow), is approved on the owner's say-so (first-time creator: the
// trust threshold alone would have held them) and scheduled at its own time → one summary email.
// Then the review window: one post is removed (its publication cancelled, its time freed).

const hasDb = Boolean(process.env.DATABASE_URL);

type Item = { id: string; status: string; kind: string; slotAt: string; projectId: string | null };
type Plan = { id: string; status: string; items: Item[]; counts: Record<string, number> };

describe.skipIf(!hasDb)('20.9 golden: plan my month', { timeout: 300_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();
  // The planner is a standalone user, so the summary email has an address and a locale.
  const plannerId = `golden-planner-${randomUUID()}`;

  beforeAll(async () => {
    await seedOverlayPresets(db);
  }, 120_000);

  afterAll(async () => {
    setApiDeps(undefined);
    await db.contentPlan.deleteMany({ where: { organisationId: { startsWith: 'golden-' } } });
    await db.autoPublishOutbox.deleteMany({ where: { organisationId: { startsWith: 'golden-' } } });
    await cleanupGolden(db, since);
    await db.user.deleteMany({ where: { id: plannerId } });
    await db.$disconnect();
  });

  it('drafts, generates and schedules a mixed month with one summary email', async () => {
    const j = startJourney(db, 'month-plan', {}, {});
    j.api.deps.resolveTenant = async () => tenant(j.org, ALL_CAPABILITIES, plannerId);
    await db.user.create({
      data: { id: plannerId, name: 'Amara', email: `${plannerId}@example.com`, locale: 'fr' },
    });
    // Publications fire at their slot (days away): hold them, as the delayed BullMQ job would.
    j.h.queue.defer.add('fire-scheduled-publication');
    j.h.queue.defer.add('poll-publication-analytics');
    // The runner is driven by hand below (the every-minute sweep in production).
    j.h.queue.defer.add('advance-content-plans');
    const tiktok = await connect(j, 'tiktok');

    // 1. Draft: 3 days × 2 a day, 50/50.
    const created = await call(plansRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        businessId: BUSINESS_ID,
        days: 3,
        postsPerDay: 2,
        videoShare: 50,
        platforms: ['tiktok'],
        targets: [{ platform: 'tiktok', connectionId: tiktok.id }],
        timezone: 'Europe/London',
      },
    });
    expect(created.status).toBe(202);
    const planId = (created.json.plan as Plan).id;
    await drain(j);
    const drafted = await getPlan(planId);
    expect(drafted.status).toBe('DRAFT');
    expect(drafted.items).toHaveLength(6);
    expect(drafted.items.filter((i) => i.kind === 'VIDEO')).toHaveLength(3);
    expect(drafted.items.filter((i) => i.kind === 'SLIDESHOW')).toHaveLength(3);

    // 2. Generate and schedule: 6 projects, allowance reserved, nothing started yet.
    const generated = await call(generatePlanRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: planId },
    });
    expect(generated.status).toBe(202);
    const queued = (generated.json.plan as Plan).items;
    expect(queued.every((i) => i.status === 'QUEUED' && i.projectId)).toBe(true);
    const projects = await db.videoProject.findMany({
      where: { id: { in: queued.map((i) => i.projectId!) } },
    });
    for (const p of projects) {
      const item = queued.find((i) => i.projectId === p.id)!;
      expect(p.reviewPolicy).toBe('AUTO_APPROVE');
      expect(p.publishPolicy).toBe('SCHEDULED');
      expect(p.scheduledStartAt?.toISOString()).toBe(item.slotAt);
      expect(p.sourceType).toBe(item.kind === 'VIDEO' ? 'BRIEF' : 'SLIDESHOW');
    }

    // 3. The runner: at most 2 at a time (STUDIO_CONTENT_PLAN_CONCURRENCY default).
    const mailer = createMemoryAuthMailer();
    const runner = {
      db,
      queue: j.h.queue,
      logger: pino({ level: 'silent' }),
      now: Date.now,
      killSwitch: j.h.deps.killSwitch,
      budget: j.h.deps.budget,
      mailer,
      appUrl: 'https://studio.example',
    };
    const first = await advanceContentPlans(runner, { planId });
    expect(first.started).toBe(2);
    expect((await getPlan(planId)).counts.GENERATING).toBe(2);
    for (let round = 0; round < 6; round += 1) {
      await drain(j);
      const result = await advanceContentPlans(runner, { planId });
      if (result.scheduled > 0) break;
    }

    // 4. Every post is scheduled at its own time; one email.
    const done = await getPlan(planId);
    expect(done.status).toBe('SCHEDULED');
    expect(done.counts.SCHEDULED).toBe(6);
    const pubs = await db.videoPublication.findMany({
      where: { projectId: { in: queued.map((i) => i.projectId!) } },
    });
    expect(pubs).toHaveLength(6);
    for (const item of queued) {
      const pub = pubs.find((p) => p.projectId === item.projectId)!;
      expect(pub.state).toBe('SCHEDULED');
      expect(pub.scheduledFor?.toISOString()).toBe(item.slotAt);
    }
    const approvals = await db.approvalTask.findMany({
      where: { projectId: { in: queued.map((i) => i.projectId!) } },
    });
    expect(approvals.every((a) => a.resolvedByUserId === 'system:auto-approve')).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      template: 'monthPlanned',
      to: `${plannerId}@example.com`,
      locale: 'fr',
      params: { postCount: 6, needsAttention: 0, url: `https://studio.example/plans/${planId}` },
    });
    await advanceContentPlans(runner, { planId });
    expect(mailer.sent).toHaveLength(1);

    // 5. The calendar shows them as held slots of the business (no free slot there).
    const upcoming = await call(upcomingRoute.GET, {
      token: 'owner',
      params: { id: BUSINESS_ID },
      path: `/api/studio/businesses/${BUSINESS_ID}/drip-queue/upcoming`,
    });
    const held = (upcoming.json.upcoming as { held: Array<{ slotAt: string }> }).held;
    expect(held.map((h) => h.slotAt).sort()).toEqual(queued.map((i) => i.slotAt).sort());

    // 6. Review window: remove the last post before its time.
    const last = queued[queued.length - 1]!;
    const removed = await call(itemRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: planId, itemId: last.id },
    });
    expect(removed.status).toBe(200);
    const pub = await db.videoPublication.findFirst({ where: { projectId: last.projectId! } });
    expect(pub?.state).toBe('CANCELLED');
    const after = (removed.json.plan as Plan).items.find((i) => i.id === last.id);
    expect(after?.status).toBe('REMOVED');
    const project = await db.videoProject.findUnique({ where: { id: last.projectId! } });
    expect(project?.publishPolicy).toBe('MANUAL');
  });

  async function getPlan(id: string): Promise<Plan> {
    const res = await call(planRoute.GET, { token: 'owner', params: { id } });
    expect(res.status).toBe(200);
    return res.json.plan as Plan;
  }
});
