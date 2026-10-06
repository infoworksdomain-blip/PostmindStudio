import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as upcomingRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/upcoming/route';
import * as dripRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/route';
import * as cancelRoute from '../../src/app/api/studio/content-plans/[id]/cancel/route';
import * as generateRoute from '../../src/app/api/studio/content-plans/[id]/generate/route';
import * as itemRoute from '../../src/app/api/studio/content-plans/[id]/items/[itemId]/route';
import * as regenerateRoute from '../../src/app/api/studio/content-plans/[id]/items/[itemId]/regenerate/route';
import * as itemsRoute from '../../src/app/api/studio/content-plans/[id]/items/route';
import * as redraftRoute from '../../src/app/api/studio/content-plans/[id]/redraft/route';
import * as reorderRoute from '../../src/app/api/studio/content-plans/[id]/reorder/route';
import * as planRoute from '../../src/app/api/studio/content-plans/[id]/route';
import * as defaultsRoute from '../../src/app/api/studio/content-plans/defaults/route';
import * as plansRoute from '../../src/app/api/studio/content-plans/route';
import * as projectGenerateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { CostCapPausedError } from '../../src/lib/errors';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { draftPlanFailed } from '../../src/lib/studio/services/content-plan-draft';
import {
  advanceContentPlans,
  syncPlanItems,
  type RunnerDeps,
} from '../../src/lib/studio/services/content-plan-run';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// 20.9 — "Plan my month" through the real routes on Postgres: defaults, create (validation,
// capability, allowance cap), the background draft, editing a draft (edit, add, delete, reorder,
// regenerate), generate and schedule (capabilities, one project per post, allowance stop), the
// review window (remove, swap), cancel, redraft, status sync, calendar integration and the
// runner's holds (kill switch, cost cap, daily limit, slots that passed).

const hasDb = Boolean(process.env.DATABASE_URL);
const HOUR = 3_600_000;

type Item = {
  id: string;
  status: string;
  kind: string;
  slotAt: string;
  title: string;
  projectId: string | null;
  statusReason: string | null;
};
type Plan = {
  id: string;
  status: string;
  items: Item[];
  counts: Record<string, number>;
  cappedReason: string | null;
  holdReason: string | null;
  requestedCount: number;
};

describe.skipIf(!hasDb)('20.9 month plans API', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p20-plan-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    writer: tenant(org, ['studio:project:read', 'studio:project:write']),
    reader: tenant(org, ['studio:project:read']),
    none: tenant(org, []),
    stranger: tenant(`api-p20-plan-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let biz: string;
  let connectionId: string;

  beforeEach(async () => {
    h = createHarness(db);
    installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    biz = `biz-${randomUUID().slice(0, 8)}`;
    const sealed = await sealTokens(h.keys, org, 'tiktok', {
      accessToken: 'tt-access',
      refreshToken: 'tt-refresh',
      expiresAt: new Date(Date.now() + HOUR),
      scopes: ['publish'],
    });
    connectionId = (
      await db.platformConnection.create({
        data: {
          organisationId: org,
          businessId: biz,
          platform: 'tiktok',
          platformAccountId: `tt-${randomUUID()}`,
          platformAccountName: 'Leeds Sourdough',
          ...sealed,
          scopes: ['publish'],
          state: 'active',
          connectedByUserId: 'user-1',
        },
      })
    ).id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.contentPlan.deleteMany({ where: { organisationId: org } });
    await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.dripQueue.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    businessId: biz,
    days: 3,
    postsPerDay: 2,
    videoShare: 50,
    platforms: ['tiktok'],
    targets: [{ platform: 'tiktok', connectionId }],
    timezone: 'Europe/London',
    ...overrides,
  });
  const create = (overrides: Record<string, unknown> = {}, token = 'owner') =>
    call(plansRoute.POST, { method: 'POST', token, body: body(overrides) });
  const getPlan = async (id: string, token = 'owner') => {
    const res = await call(planRoute.GET, { token, params: { id } });
    return { status: res.status, plan: res.json.plan as Plan };
  };
  const drain = () => drainInline(h.queue, h.deps);
  async function drafted(overrides: Record<string, unknown> = {}): Promise<Plan> {
    const res = await create(overrides);
    expect(res.status).toBe(202);
    await drain();
    return (await getPlan((res.json.plan as Plan).id)).plan;
  }
  const generate = (id: string, token = 'owner') =>
    call(generateRoute.POST, { method: 'POST', token, params: { id } });
  const runner = (patch: Partial<RunnerDeps> = {}): RunnerDeps => ({
    db,
    queue: h.queue,
    logger: pino({ level: 'silent' }),
    now: Date.now,
    killSwitch: { check: async () => ({ killed: false }) },
    ...patch,
  });

  it('GET defaults: next free day, posts a day from the posting times, allowance', async () => {
    const res = await call(defaultsRoute.GET, {
      token: 'reader',
      path: `/api/studio/content-plans/defaults?businessId=${biz}&timezone=Europe/London`,
    });
    expect(res.status).toBe(200);
    const d = res.json.defaults as Record<string, unknown>;
    expect(d).toMatchObject({ days: 30, maxDays: 31, postsPerDay: 1, hasPostingTimes: false });
    expect(d.allowance).toMatchObject({ mode: 'warn', remaining: null });

    const slots = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
      ['09:00', '17:00'].map((time) => ({ weekday, time, timezone: 'Europe/London' })),
    );
    await call(dripRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: biz },
      body: { slots },
    });
    const again = await call(defaultsRoute.GET, {
      token: 'reader',
      path: `/api/studio/content-plans/defaults?businessId=${biz}`,
    });
    expect(again.json.defaults).toMatchObject({ postsPerDay: 2, hasPostingTimes: true });

    const none = await call(defaultsRoute.GET, {
      token: 'none',
      path: `/api/studio/content-plans/defaults?businessId=${biz}`,
    });
    expect(none.status).toBe(403);
  });

  it('POST validates capability, accounts and posting times', async () => {
    expect((await create({}, 'reader')).status).toBe(403);
    // 20.12: a target for a platform the plan does not render is still refused; a plan with no
    // (or partial) accounts is allowed (test/api/p20-autopublish-accounts.test.ts).
    const stray = await create({ targets: [{ platform: 'x', connectionId }] });
    expect(stray.status).toBe(400);
    expect((await create({ useDripSlots: true, postsPerDay: undefined })).status).toBe(400);
    expect((await create({ days: 32 })).status).toBe(400);
  });

  it('QA: a queue outage answers 502 and leaves no stuck draft that blocks the next try', async () => {
    const add = h.queue.add.bind(h.queue);
    h.queue.add = async () => Promise.reject(new Error('redis unavailable'));
    const failed = await create();
    expect(failed.status).toBe(502);
    expect(await db.contentPlan.count({ where: { organisationId: org, businessId: biz } })).toBe(0);
    h.queue.add = add;
    expect((await create()).status).toBe(202);
  });

  it('creates a draft (3 days × 2), writes it in the background, lists and scopes it', async () => {
    const res = await create();
    expect(res.status).toBe(202);
    const plan = res.json.plan as Plan;
    expect(plan.status).toBe('DRAFTING');
    expect(plan.items).toHaveLength(6);
    expect(plan.items.every((i) => i.title === '')).toBe(true);
    expect(h.queue.pending.map((j) => j.name)).toContain('draft-content-plan');
    // One draft at a time per business.
    expect((await create()).status).toBe(409);

    await drain();
    const { plan: ready } = await getPlan(plan.id);
    expect(ready.status).toBe('DRAFT');
    expect(ready.items.every((i) => i.title.length > 0)).toBe(true);
    expect(ready.items.filter((i) => i.kind === 'VIDEO')).toHaveLength(3);

    const list = await call(plansRoute.GET, {
      token: 'reader',
      path: `/api/studio/content-plans?businessId=${biz}`,
    });
    expect((list.json.data as Array<{ id: string }>).map((p) => p.id)).toEqual([plan.id]);
    expect((await getPlan(plan.id, 'stranger')).status).toBe(404);
  });

  it('edits a draft: topic, kind, add (≤ 4 a day, inside the window), delete, reorder, regenerate', async () => {
    const plan = await drafted();
    const [first, second] = plan.items;
    const patched = await call(itemRoute.PATCH, {
      method: 'PATCH',
      token: 'writer',
      params: { id: plan.id, itemId: first!.id },
      body: { title: 'Our rye starter', kind: 'SLIDESHOW' },
    });
    expect(patched.status).toBe(200);
    const edited = (patched.json.plan as Plan).items.find((i) => i.id === first!.id)!;
    expect(edited).toMatchObject({ title: 'Our rye starter', kind: 'SLIDESHOW' });

    const day1 = new Date(first!.slotAt);
    const add = (at: Date) =>
      call(itemsRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: plan.id },
        body: { slotAt: at.toISOString(), kind: 'VIDEO', title: 'Extra', brief: 'An extra post' },
      });
    expect((await add(new Date(day1.getTime() + 2 * HOUR))).status).toBe(201);
    expect((await add(new Date(day1.getTime() + 3 * HOUR))).status).toBe(201);
    expect((await add(new Date(day1.getTime() + 4 * HOUR))).status).toBe(400); // fifth that day
    expect((await add(new Date(day1.getTime() + 40 * 24 * HOUR))).status).toBe(400); // outside
    expect((await add(day1)).status).toBe(409); // time taken

    const deleted = await call(itemRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: plan.id, itemId: second!.id },
    });
    expect((deleted.json.plan as Plan).items).toHaveLength(7);

    const current = (deleted.json.plan as Plan).items;
    const reversed = [...current].reverse().map((i) => i.id);
    const reordered = await call(reorderRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: plan.id },
      body: { itemIds: reversed },
    });
    expect(reordered.status).toBe(200);
    const after = (reordered.json.plan as Plan).items;
    expect(after.map((i) => i.slotAt)).toEqual(current.map((i) => i.slotAt));
    expect(after.map((i) => i.id)).toEqual(reversed);
    expect(
      (
        await call(reorderRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: plan.id },
          body: { itemIds: reversed.slice(1) },
        })
      ).status,
    ).toBe(400);

    const regenerated = await call(regenerateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: plan.id, itemId: after[0]!.id },
    });
    expect(regenerated.status).toBe(200);
    const row = await db.contentPlan.findUnique({ where: { id: plan.id } });
    expect((row?.metadata as { regenerations?: number }).regenerations).toBe(1);
  });

  it('caps the draft at the remaining allowance, and refuses when nothing is left', async () => {
    vi.stubEnv('STUDIO_QUOTA_MODE', 'enforce');
    vi.stubEnv('STUDIO_QUOTA_STANDARD_SHORT', '2');
    // All videos (23.3: slideshows would count ¼ each; see the next test).
    const res = await create({ videoShare: 100 });
    expect(res.status).toBe(202);
    const plan = res.json.plan as Plan;
    expect(plan.items).toHaveLength(2);
    expect(plan).toMatchObject({ requestedCount: 6, cappedReason: 'allowance' });
    await drain();
    vi.stubEnv('STUDIO_QUOTA_STANDARD_SHORT', '0');
    const refused = await create({ startDate: undefined, days: 2 });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: 'quota_exceeded' });
  });

  it('23.3: slideshows count ¼ of a video, so one video of allowance covers four of them', async () => {
    vi.stubEnv('STUDIO_QUOTA_MODE', 'enforce');
    vi.stubEnv('STUDIO_QUOTA_STANDARD_SHORT', '1');
    const res = await create({ videoShare: 0 });
    expect(res.status).toBe(202);
    const plan = res.json.plan as Plan;
    expect(plan.items).toHaveLength(4);
    expect(plan).toMatchObject({ requestedCount: 6, cappedReason: 'allowance' });
    expect(res.json.allowance).toMatchObject({ limit: 1, used: 0, remaining: 1 });
    // Not counted against the drafts-per-day limit the later tests rely on.
    await drain();
    await db.contentPlan.delete({ where: { id: plan.id } });
  });

  it('stops cleanly at the allowance when generating: later posts are skipped', async () => {
    vi.stubEnv('STUDIO_QUOTA_MODE', 'enforce');
    vi.stubEnv('STUDIO_QUOTA_STANDARD_SHORT', '3');
    const plan = await drafted({ days: 3, postsPerDay: 1, videoShare: 100 });
    expect(plan.items).toHaveLength(3);
    // Another video uses one of the three meanwhile.
    const other = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        businessId: biz,
        brief: { rawInput: 'A one-off video' },
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      },
    });
    const otherId = (other.json.project as { id: string }).id;
    expect(
      (
        await call(projectGenerateRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: otherId },
          body: {},
        })
      ).status,
    ).toBe(202);
    const res = await generate(plan.id);
    const items = (res.json.plan as Plan).items;
    expect(items.map((i) => i.status)).toEqual(['QUEUED', 'QUEUED', 'SKIPPED']);
    expect(items[2]!.statusReason).toBe('allowance');
    expect((res.json.plan as Plan).cappedReason).toBe('allowance');
  });

  it('generate needs approve + publish rights, makes one project per post and kicks the runner', async () => {
    const plan = await drafted();
    expect((await generate(plan.id, 'writer')).status).toBe(403);
    const res = await generate(plan.id);
    expect(res.status).toBe(202);
    const items = (res.json.plan as Plan).items;
    expect(items.every((i) => i.status === 'QUEUED' && i.projectId)).toBe(true);
    const projects = await db.videoProject.findMany({
      where: { id: { in: items.map((i) => i.projectId!) } },
    });
    expect(projects).toHaveLength(6);
    for (const p of projects) {
      expect(p.state).toBe('DRAFT');
      expect(p.reviewPolicy).toBe('AUTO_APPROVE');
      expect(p.publishPolicy).toBe('SCHEDULED');
      const meta = p.metadata as Record<string, unknown>;
      expect(meta.contentPlan).toMatchObject({ planId: plan.id, preApproved: true });
      expect(meta.quotaSlot).toBeTruthy();
      expect((meta.autoPublish as { targets: unknown[] }).targets).toHaveLength(1);
    }
    expect(h.queue.pending.map((j) => j.name)).toContain('advance-content-plans');
    // Resuming is safe: no second set of projects.
    expect((await generate(plan.id)).status).toBe(202);
    expect(await db.videoProject.count({ where: { organisationId: org, businessId: biz } })).toBe(
      6,
    );

    // The calendar holds the plan's times and shows the posts still being made.
    const upcoming = await call(upcomingRoute.GET, {
      token: 'reader',
      params: { id: biz },
      path: `/api/studio/businesses/${biz}/drip-queue/upcoming?from=${encodeURIComponent(
        new Date().toISOString(),
      )}`,
    });
    const view = upcoming.json.upcoming as {
      held: Array<{ slotAt: string }>;
      planned: Array<{ itemId: string; status: string }>;
    };
    expect(view.held).toHaveLength(6);
    expect(view.planned.map((p) => p.itemId).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('review window: remove a queued post (allowance given back), swap another, cancel the plan', async () => {
    const plan = await drafted();
    const items = ((await generate(plan.id)).json.plan as Plan).items;
    const [a, b] = items;

    // Removing a scheduled post cancels its publication: publication:write is needed.
    expect(
      (
        await call(itemRoute.DELETE, {
          method: 'DELETE',
          token: 'writer',
          params: { id: plan.id, itemId: a!.id },
        })
      ).status,
    ).toBe(403);
    const removed = await call(itemRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: plan.id, itemId: a!.id },
    });
    expect(removed.status).toBe(200);
    const projectA = await db.videoProject.findUnique({ where: { id: a!.projectId! } });
    expect(projectA?.state).toBe('ARCHIVED');
    expect((projectA?.metadata as Record<string, unknown>).quotaSlot).toBeUndefined();
    expect((removed.json.plan as Plan).items.find((i) => i.id === a!.id)?.status).toBe('REMOVED');

    expect(
      (
        await call(itemRoute.PATCH, {
          method: 'PATCH',
          token: 'writer',
          params: { id: plan.id, itemId: b!.id },
          body: { title: 'Swapped' },
        })
      ).status,
    ).toBe(403);
    const swapped = await call(itemRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: plan.id, itemId: b!.id },
      body: { title: 'Swapped topic', brief: 'Something else', kind: 'SLIDESHOW' },
    });
    expect(swapped.status).toBe(200);
    const newB = (swapped.json.plan as Plan).items.find((i) => i.id === b!.id)!;
    expect(newB).toMatchObject({ status: 'QUEUED', title: 'Swapped topic', kind: 'SLIDESHOW' });
    expect(newB.projectId).not.toBe(b!.projectId);
    expect((await db.videoProject.findUnique({ where: { id: b!.projectId! } }))?.state).toBe(
      'ARCHIVED',
    );

    const cancelled = await call(cancelRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: plan.id },
    });
    expect(cancelled.status).toBe(200);
    const final = cancelled.json.plan as Plan;
    expect(final.status).toBe('CANCELLED');
    expect(final.items.every((i) => i.status === 'REMOVED')).toBe(true);
    expect(
      (await call(cancelRoute.POST, { method: 'POST', token: 'owner', params: { id: plan.id } }))
        .status,
    ).toBe(409);
  });

  it('redraft writes the posts a failed draft left empty', async () => {
    const res = await create();
    const id = (res.json.plan as Plan).id;
    h.queue.pending.splice(0); // the draft job "fails"
    await draftPlanFailed(db, id, 'draft_failed');
    const { plan } = await getPlan(id);
    expect(plan.status).toBe('DRAFT');
    expect((await generate(id)).status).toBe(409); // untitled posts
    const again = await call(redraftRoute.POST, { method: 'POST', token: 'owner', params: { id } });
    expect(again.status).toBe(202);
    expect((again.json.plan as Plan).status).toBe('DRAFTING');
    await drain();
    expect((await getPlan(id)).plan.items.every((i) => i.title)).toBe(true);
  });

  it('the runner holds for the kill switch, the cost cap and the daily limit, and skips missed times', async () => {
    const plan = await drafted();
    await generate(plan.id);
    h.queue.pending.splice(0);

    const killed = runner({
      killSwitch: { check: async () => ({ killed: true, level: 'workspace', key: 'k' }) },
    });
    expect((await advanceContentPlans(killed, { planId: plan.id })).started).toBe(0);
    expect((await getPlan(plan.id)).plan.holdReason).toBe('kill_switch');

    const capped = runner({
      budget: {
        assertNotPaused: async () => {
          throw new CostCapPausedError('org_monthly', 'cap reached');
        },
      },
    });
    await advanceContentPlans(capped, { planId: plan.id });
    expect((await getPlan(plan.id)).plan.holdReason).toBe('cost_cap');

    // A post whose time is too close to make is skipped (and its allowance given back).
    const first = (await getPlan(plan.id)).plan.items[0]!;
    await db.contentPlanItem.update({
      where: { id: first.id },
      data: { slotAt: new Date(Date.now() + 10 * 60_000) },
    });
    vi.stubEnv('STUDIO_CONTENT_PLAN_DAILY_STARTS', '1000');
    const started = await advanceContentPlans(runner(), { planId: plan.id });
    expect(started.started).toBe(2);
    const afterStart = (await getPlan(plan.id)).plan;
    expect(afterStart.holdReason).toBeNull();
    expect(afterStart.items.find((i) => i.id === first.id)).toMatchObject({
      status: 'SKIPPED',
      statusReason: 'slot_passed',
    });
    expect(afterStart.counts.GENERATING).toBe(2);

    vi.stubEnv('STUDIO_CONTENT_PLAN_DAILY_STARTS', '1');
    await advanceContentPlans(runner(), { planId: plan.id });
    expect((await getPlan(plan.id)).plan.holdReason).toBe('daily_limit');
  });

  it('23.6 rolling: only the first posts and the 72 h window start; the tick starts the rest later', async () => {
    vi.stubEnv('STUDIO_CONTENT_PLAN_CONCURRENCY', '10');
    // At most 3 plans generate per organisation: set the earlier tests' plans aside (restored at
    // the end; the last test relies on them).
    const aside = await db.contentPlan.findMany({
      where: { organisationId: org, status: { in: ['GENERATING', 'SCHEDULED'] } },
      select: { id: true, status: true },
    });
    await db.contentPlan.updateMany({
      where: { id: { in: aside.map((a) => a.id) } },
      data: { status: 'CANCELLED' },
    });
    const restore = async (mine: string) => {
      // Cancelled and out of today's draft quota (MAX_PLAN_DRAFTS_PER_DAY) for the later tests.
      await db.contentPlan.update({
        where: { id: mine },
        data: { status: 'CANCELLED', createdAt: new Date(Date.now() - 2 * 24 * HOUR) },
      });
      for (const a of aside)
        await db.contentPlan.update({ where: { id: a.id }, data: { status: a.status } });
    };
    const plan = await drafted({ days: 10, postsPerDay: 3, videoShare: 0 });
    await generate(plan.id);
    h.queue.pending.splice(0);
    const now = Date.now();
    const items = (await getPlan(plan.id)).plan.items;
    expect(items).toHaveLength(30);
    const windowEnd = now + 72 * HOUR;
    const due = items.filter((i, n) => n < 3 || Date.parse(i.slotAt) <= windowEnd);
    expect(due.length).toBeLessThan(items.length);

    expect((await advanceContentPlans(runner(), { planId: plan.id })).started).toBe(due.length);
    const after = (await getPlan(plan.id)).plan;
    const waiting = after.items.filter((i) => i.status === 'QUEUED');
    expect(waiting).toHaveLength(items.length - due.length);
    // The calendar's "Scheduled to be created on": the slot minus the 72 h window.
    for (const item of waiting) {
      const createsAt = (item as Item & { createsAt: string | null }).createsAt;
      expect(Date.parse(createsAt!)).toBe(Date.parse(item.slotAt) - 72 * HOUR);
    }
    // The first three run at normal priority (the owner sees them at once), the rest as batch.
    const planJobs = h.queue.pending.filter((j) => j.name === 'plan-project');
    const batchOf = (projectId: string | null) =>
      (planJobs.find((j) => j.data.projectId === projectId)?.data as { batch?: boolean })?.batch;
    expect(due.slice(0, 3).map((i) => batchOf(i.projectId) ?? false)).toEqual([
      false,
      false,
      false,
    ]);
    if (due.length > 3) expect(batchOf(due[3]!.projectId)).toBe(true);

    // Four days later the next posts have entered the window: the periodic tick starts them.
    const later = runner({ now: () => now + 4 * 24 * HOUR });
    expect((await advanceContentPlans(later, { planId: plan.id })).started).toBeGreaterThan(0);
    await restore(plan.id);
  });

  it('syncs held, ready and failed posts from their projects', async () => {
    // At most 3 generating plans per organisation (429): earlier tests left 3 running.
    const blocked = await drafted({ days: 1, postsPerDay: 3 });
    expect((await generate(blocked.id)).status).toBe(429);
    await db.contentPlan.updateMany({
      where: { organisationId: org, status: 'GENERATING' },
      data: { status: 'COMPLETED' },
    });
    const plan = blocked;
    const items = ((await generate(plan.id)).json.plan as Plan).items;
    h.queue.pending.splice(0);
    const [held, ready, failed] = items.map((i) => i.projectId!);
    await db.videoProject.update({
      where: { id: held },
      data: {
        state: 'READY_FOR_REVIEW',
        metadata: { review: { decision: 'needs_review', code: 'content_safety_flag' } },
      },
    });
    await db.videoProject.update({
      where: { id: ready },
      data: {
        state: 'READY_FOR_REVIEW',
        metadata: { review: { decision: 'needs_review', code: 'quality_not_clean' } },
      },
    });
    await db.videoProject.update({
      where: { id: failed },
      data: { state: 'FAILED', errorReason: 'provider timeout' },
    });
    await db.contentPlan.update({ where: { id: plan.id }, data: { status: 'GENERATING' } });
    expect(await syncPlanItems(db, plan.id)).toBe(3);
    const { plan: synced } = await getPlan(plan.id);
    expect(synced.items.map((i) => i.status)).toEqual(['HELD', 'READY', 'FAILED']);
    expect(synced.counts).toMatchObject({ HELD: 1, READY: 1, FAILED: 1 });
    // Everything settled: the runner marks the plan scheduled (no mailer: nothing sent).
    await advanceContentPlans(runner(), { planId: plan.id });
    expect((await getPlan(plan.id)).plan.status).toBe('SCHEDULED');
  });
});
