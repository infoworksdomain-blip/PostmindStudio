import { randomUUID } from 'node:crypto';
import type { ContentPlan, ContentPlanItem, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  UpstreamServiceError,
  ValidationError,
} from '../../errors';
import type { TenantContext } from '../../tenant';
import { isValidTimeZone } from '../automation/zoned-time';
import {
  assertMayConfigureTargets,
  autoPublishTargets,
  validateTargets,
  type AutoPublishTarget,
} from '../automation/targets';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { calendarDaysBetween } from '../content-plans/calendar-days';
import {
  capItems,
  estimateCost,
  loadPlanAllowance,
  type PlanAllowance,
  type PlanCost,
} from '../content-plans/allowance';
import { buildSkeleton, DEFAULT_VIDEO_SHARE, type PlanKind } from '../content-plans/mix';
import {
  availableSlots,
  dailySlots,
  defaultStartDate,
  DEFAULT_PLAN_DAYS,
  dripSlotsInWindow,
  formatLocalDate,
  MAX_PLAN_DAYS,
  MAX_POSTS_PER_DAY,
  parseLocalDate,
  planWindow,
  postsPerDayFromDrip,
} from '../content-plans/slots';
import { countStatuses } from '../content-plans/status';
import { DEFAULT_LANGUAGE, languageInput } from '../languages';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import { MAX_SCHEDULE_AHEAD_DAYS } from '../schedule-window';
import { planUsesUgcActors } from '../ugc/plan-month';
import { isUgcLanguage } from '../ugc/style';
import { businessIdParam } from './businesses';
import { PLATFORMS, toPlanTier } from './catalog';
import { heldSlots, parseSlots } from './drip-queue';
import { tierQuota, videoLimitViolations } from './plan-quotas';
import { loadPlanContext, writeTopics, type PlanGenerator } from './content-plan-draft';

// 20.9 — "Plan my month" (operator request 2026-09-30): the owner picks a window (default the
// next free day for 30 days, at most 31), posts a day (1–4, or the business's posting times), the
// video/slideshow split and the platforms; Studio lays out the slots (content-plans/slots.ts),
// the varied mix (mix.ts), caps the count at the remaining allowance and cost cap (allowance.ts)
// and has Claude write the topics in the background (draft-content-plan job). The owner edits the
// DRAFT (topic, kind, add, delete, reorder, regenerate one) before "Generate and schedule"
// (services/content-plan-run.ts). Every query is scoped by organisationId.

export const MAX_PLAN_DRAFTS_PER_DAY = 10;
export const MAX_REGENERATIONS_PER_PLAN = 60;
export const DEFAULT_PLAN_TIMEZONE = 'Europe/London';
const DAY_MS = 86_400_000;

const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'timezone must be an IANA time zone' });

export const createPlanInput = z
  .object({
    businessId: businessIdParam,
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
      .optional(),
    days: z.number().int().min(1).max(MAX_PLAN_DAYS).default(DEFAULT_PLAN_DAYS),
    postsPerDay: z.number().int().min(1).max(MAX_POSTS_PER_DAY).optional(),
    useDripSlots: z.boolean().default(false),
    videoShare: z.number().int().min(0).max(100).default(DEFAULT_VIDEO_SHARE),
    platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
    /**
     * 20.12: the accounts the posts go to — none, or some of the platforms, is allowed. A
     * platform without an account is still rendered; with no account at all every post is made
     * and saved for review instead of being scheduled (content-plan-run.ts projectBodyFor).
     */
    targets: autoPublishTargets.default([]),
    timezone: timezone.optional(),
    language: languageInput.optional(),
    brandKitId: z.string().trim().min(1).max(64).optional(),
    /**
     * 21.4: make the plan's testimonial and product videos as UGC actor videos (STANDARD and
     * above, English). Stored in metadata.ugcActors; content-plan-run.ts projectBodyFor applies it.
     */
    ugcActors: z.boolean().default(false),
  })
  .strict();

export type CreatePlanInput = z.infer<typeof createPlanInput>;

export const defaultsQuery = z.object({
  businessId: businessIdParam,
  timezone: timezone.optional(),
});

export const listPlansQuery = z.object({ businessId: businessIdParam.optional() });

const slidesInput = z
  .object({
    hook: z.string().trim().max(120),
    points: z.array(z.string().trim().min(1).max(100)).min(1).max(5),
    cta: z.string().trim().max(80),
  })
  .strict();

export const updateItemInput = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    brief: z.string().trim().min(1).max(600).optional(),
    kind: z.enum(['VIDEO', 'SLIDESHOW']).optional(),
    slides: slidesInput.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const addItemInput = z
  .object({
    /** An instant inside the plan's window, at least PLAN_MIN_LEAD_MS ahead. */
    slotAt: z.iso.datetime({ offset: true }),
    kind: z.enum(['VIDEO', 'SLIDESHOW']),
    title: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(600),
    slides: slidesInput.optional(),
  })
  .strict();

export const reorderInput = z
  .object({ itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200) })
  .strict();

type Db = PrismaClient;

export interface PlanDeps {
  db: Db;
  queue: JobQueue;
  now: () => number;
  env?: Record<string, string | undefined>;
  entitlements?: EntitlementsReader;
}

export type PlanWithItems = ContentPlan & { items: ContentPlanItem[] };

export async function findPlan(
  db: Pick<Db, 'contentPlan'>,
  organisationId: string,
  id: string,
): Promise<PlanWithItems> {
  const plan = await db.contentPlan.findFirst({
    where: { id, organisationId },
    include: { items: { orderBy: [{ slotAt: 'asc' }, { position: 'asc' }] } },
  });
  if (!plan) throw new NotFoundError('Plan not found');
  return plan;
}

export function planTargets(plan: Pick<ContentPlan, 'targets'>): AutoPublishTarget[] {
  const parsed = autoPublishTargets.safeParse(plan.targets);
  return parsed.success ? parsed.data : [];
}

/** Items the plan still counts (not removed or skipped). */
const liveItems = (items: ContentPlanItem[]) =>
  items.filter((i) => i.status !== 'REMOVED' && i.status !== 'SKIPPED');

export function publicPlan(plan: PlanWithItems) {
  const tier = toPlanTier(plan.planTier ?? undefined);
  const live = liveItems(plan.items);
  return {
    id: plan.id,
    businessId: plan.businessId,
    status: plan.status,
    startDate: plan.startDate,
    days: plan.days,
    timezone: plan.timezone,
    windowStart: plan.windowStart.toISOString(),
    windowEnd: plan.windowEnd.toISOString(),
    postsPerDay: plan.postsPerDay,
    useDripSlots: plan.useDripSlots,
    videoShare: plan.videoShare,
    platforms: plan.platforms,
    targets: planTargets(plan).map((t) => ({
      platform: t.platform,
      connectionId: t.connectionId ?? null,
      platformAccountId: t.platformAccountId ?? null,
    })),
    language: plan.language,
    brandKitId: plan.brandKitId,
    ugcActors: planUsesUgcActors(plan),
    requestedCount: plan.requestedCount,
    cappedReason: plan.cappedReason,
    holdReason: plan.holdReason,
    draftError: plan.draftError,
    createdAt: plan.createdAt.toISOString(),
    generationStartedAt: plan.generationStartedAt?.toISOString() ?? null,
    scheduledAt: plan.scheduledAt?.toISOString() ?? null,
    completedAt: plan.completedAt?.toISOString() ?? null,
    cancelledAt: plan.cancelledAt?.toISOString() ?? null,
    counts: countStatuses(plan.items.map((i) => i.status)),
    estimate: estimateCost(
      live.map((i) => i.kind as PlanKind),
      tier,
    ),
    items: plan.items.map((i) => ({
      id: i.id,
      position: i.position,
      slotAt: i.slotAt.toISOString(),
      kind: i.kind,
      angle: i.angle,
      title: i.title,
      brief: i.brief,
      slides: i.slides,
      calendarDay: i.calendarDay,
      postCopy: i.postCopy ?? null,
      status: i.status,
      statusReason: i.statusReason,
      projectId: i.projectId,
    })),
  };
}

// ------------------------------------------------------------------ defaults and allowance

async function latestActiveWindowEnd(
  db: Pick<Db, 'contentPlan'>,
  scope: { organisationId: string; businessId: string },
): Promise<number | undefined> {
  const latest = await db.contentPlan.findFirst({
    where: { ...scope, status: { in: ['DRAFT', 'GENERATING', 'SCHEDULED'] } },
    orderBy: { windowEnd: 'desc' },
    select: { windowEnd: true },
  });
  return latest?.windowEnd.getTime();
}

/** GET /content-plans/defaults — what the "Plan my month" form starts from. */
export async function planDefaults(
  deps: PlanDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  query: z.infer<typeof defaultsQuery>,
) {
  const scope = { organisationId: tenant.organisationId, businessId: query.businessId };
  const now = deps.now();
  const tier = toPlanTier(tenant.organisation.planTier);
  const queue = await deps.db.dripQueue.findUnique({ where: { organisationId_businessId: scope } });
  const slots = queue?.enabled ? parseSlots(queue.slots) : [];
  const zone = query.timezone ?? slots[0]?.timezone ?? DEFAULT_PLAN_TIMEZONE;
  const start = defaultStartDate(now, zone, await latestActiveWindowEnd(deps.db, scope));
  const { allowance, cost } = await loadPlanAllowance(deps, tenant.organisationId, tier);
  return {
    timezone: zone,
    startDate: formatLocalDate(start),
    days: DEFAULT_PLAN_DAYS,
    maxDays: MAX_PLAN_DAYS,
    postsPerDay: slots.length ? postsPerDayFromDrip(slots.length) : 1,
    maxPostsPerDay: MAX_POSTS_PER_DAY,
    hasPostingTimes: slots.length > 0,
    postingTimesPerWeek: slots.length,
    videoShare: DEFAULT_VIDEO_SHARE,
    planTier: tier,
    allowance,
    cost,
    typicalCostPence: {
      VIDEO: estimateCost(['VIDEO'], tier).typicalPence,
      SLIDESHOW: estimateCost(['SLIDESHOW'], tier).typicalPence,
    },
  };
}

// ------------------------------------------------------------------ create (draft)

async function assertDraftQuota(db: Pick<Db, 'contentPlan'>, organisationId: string, now: number) {
  const today = await db.contentPlan.count({
    where: { organisationId, createdAt: { gte: new Date(now - DAY_MS) } },
  });
  if (today >= MAX_PLAN_DRAFTS_PER_DAY)
    throw new RateLimitError(
      `At most ${MAX_PLAN_DRAFTS_PER_DAY} month plans can be drafted per 24 hours`,
      3_600,
    );
}

function assertPlatformsAllowed(
  tier: PlanTier,
  platforms: string[],
  env?: Record<string, string | undefined>,
) {
  const quota = tierQuota(tier, env);
  const violations = videoLimitViolations(
    {
      sourceType: 'BRIEF',
      targetFormats: platforms.map((platform) => ({ platform, duration: 15 })),
    },
    quota,
    tier,
  ).filter((v) => v.code === 'platforms');
  if (violations.length)
    throw new ValidationError(violations[0]!.message, { code: 'platforms', platforms });
}

async function assertTargets(
  db: Db,
  tenant: Pick<TenantContext, 'organisationId' | 'capabilities'>,
  platforms: string[],
  targets: AutoPublishTarget[],
) {
  assertMayConfigureTargets(tenant, targets);
  await validateTargets(db, tenant.organisationId, targets, platforms);
}

/** The candidate post times for a new plan (before other videos' held slots are removed). */
async function candidateSlots(
  db: Db,
  scope: { organisationId: string; businessId: string },
  input: { useDripSlots: boolean; postsPerDay: number; days: number },
  start: ReturnType<typeof parseLocalDate>,
  zone: string,
): Promise<number[]> {
  const window = planWindow(start, input.days, zone);
  if (!input.useDripSlots) return dailySlots(start, input.days, input.postsPerDay, zone);
  const queue = await db.dripQueue.findUnique({ where: { organisationId_businessId: scope } });
  const slots = queue?.enabled ? parseSlots(queue.slots) : [];
  if (slots.length === 0)
    throw new ValidationError('This business has no posting times; choose posts a day instead', {
      code: 'no_posting_times',
    });
  return dripSlotsInWindow(slots, window, zone);
}

/** POST /content-plans — lay out the month and start the background draft. */
export async function createPlan(
  deps: PlanDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'userId' | 'capabilities' | 'organisation'>,
  input: CreatePlanInput,
) {
  const now = deps.now();
  const tier = toPlanTier(tenant.organisation.planTier);
  const scope = { organisationId: tenant.organisationId, businessId: input.businessId };
  await assertDraftQuota(deps.db, tenant.organisationId, now);
  assertPlatformsAllowed(tier, input.platforms, deps.env);
  await assertTargets(deps.db, tenant, input.platforms, input.targets);
  if (input.ugcActors) {
    if (!isUgcLanguage(input.language ?? DEFAULT_LANGUAGE))
      throw new ValidationError('UGC actors speak English only for now', { field: 'language' });
  }
  if (input.brandKitId) {
    const kit = await deps.db.brandKit.findFirst({
      where: { id: input.brandKitId, organisationId: tenant.organisationId },
      select: { id: true },
    });
    if (!kit) throw new ValidationError('brandKitId does not exist in this organisation');
  }
  const drafting = await deps.db.contentPlan.findFirst({
    where: { ...scope, status: 'DRAFTING' },
    select: { id: true },
  });
  if (drafting)
    throw new ConflictError('A month plan for this business is still being drafted', {
      planId: drafting.id,
    });
  const queue = await deps.db.dripQueue.findUnique({ where: { organisationId_businessId: scope } });
  const zone =
    input.timezone ?? parseSlots(queue?.slots ?? [])[0]?.timezone ?? DEFAULT_PLAN_TIMEZONE;
  const start = input.startDate
    ? parseLocalDate(input.startDate)
    : defaultStartDate(now, zone, await latestActiveWindowEnd(deps.db, scope));
  const window = planWindow(start, input.days, zone);
  if (window.windowEnd <= now) throw new ValidationError('The plan window is in the past');
  if (window.windowEnd > now + MAX_SCHEDULE_AHEAD_DAYS * DAY_MS)
    throw new ValidationError(`A plan must end within ${MAX_SCHEDULE_AHEAD_DAYS} days`, {
      maxDays: MAX_SCHEDULE_AHEAD_DAYS,
    });
  const postsPerDay =
    input.postsPerDay ?? (queue?.enabled ? postsPerDayFromDrip(parseSlots(queue.slots).length) : 1);
  const candidates = await candidateSlots(
    deps.db,
    scope,
    { useDripSlots: input.useDripSlots, postsPerDay, days: input.days },
    start,
    zone,
  );
  const held = await heldSlots(deps.db, scope, window.windowStart);
  const slots = availableSlots(
    candidates,
    held.map((h) => h.slotAt),
    now,
  );
  if (slots.length === 0)
    throw new ValidationError('There are no free posting times left in this window', {
      code: 'no_free_slots',
    });
  const skeleton = buildSkeleton({
    slots,
    videoShare: input.videoShare,
    calendarDays: calendarDaysBetween(start, input.days),
    timezone: zone,
  });
  const { allowance, cost } = await loadPlanAllowance(deps, tenant.organisationId, tier);
  const capped = capItems(
    skeleton.map((s) => s.kind),
    tier,
    allowance,
    cost,
  );
  if (capped.count === 0)
    throw new QuotaExceededError(
      capped.cappedReason === 'cost_cap'
        ? 'This month’s limit leaves no room for more posts; buy a video pack to plan your month'
        : 'Your plan has no videos left for now; add a channel or buy a video pack to plan your month',
      { cappedReason: capped.cappedReason, allowance, cost },
    );
  const runId = randomUUID();
  const plan = await deps.db.contentPlan.create({
    data: {
      organisationId: tenant.organisationId,
      businessId: input.businessId,
      createdByUserId: tenant.userId,
      status: 'DRAFTING',
      startDate: formatLocalDate(start),
      days: input.days,
      timezone: zone,
      windowStart: new Date(window.windowStart),
      windowEnd: new Date(window.windowEnd),
      postsPerDay,
      useDripSlots: input.useDripSlots,
      videoShare: input.videoShare,
      platforms: input.platforms,
      targets: input.targets as unknown as Prisma.InputJsonValue,
      language: input.language ?? DEFAULT_LANGUAGE,
      brandKitId: input.brandKitId ?? null,
      planTier: tier,
      requestedCount: skeleton.length,
      cappedReason: capped.cappedReason,
      metadata: { draftRunId: runId, ...(input.ugcActors && { ugcActors: true }) },
      items: {
        create: skeleton.slice(0, capped.count).map((s, position) => ({
          organisationId: tenant.organisationId,
          position,
          slotAt: new Date(s.slotAt),
          kind: s.kind,
          angle: s.angle,
          calendarDay: s.calendarDay,
          title: '',
          brief: '',
        })),
      },
    },
    include: { items: { orderBy: [{ slotAt: 'asc' }, { position: 'asc' }] } },
  });
  try {
    await enqueueDraft(deps.queue, plan, runId, tier);
  } catch (err) {
    // The queue is unreachable: nothing will ever write the topics. Remove the empty draft so it
    // does not sit in DRAFTING and block the next attempt (409 "still being drafted").
    await deps.db.contentPlan.delete({ where: { id: plan.id } });
    throw new UpstreamServiceError('Month planning is unavailable right now; try again shortly', {
      cause: err instanceof Error ? err.message : 'queue_unavailable',
    });
  }
  return { plan, allowance, cost };
}

async function enqueueDraft(queue: JobQueue, plan: ContentPlan, runId: string, tier: PlanTier) {
  const data = { organisationId: plan.organisationId, planId: plan.id, runId, planTier: tier };
  await queue.add('draft-content-plan', data, { jobId: jobIds.draftContentPlan(data) });
}

/** POST /content-plans/:id/redraft — write the items that still have no topic (after a failure). */
export async function redraftPlan(deps: PlanDeps, organisationId: string, id: string) {
  const plan = await findPlan(deps.db, organisationId, id);
  if (plan.status !== 'DRAFT')
    throw new ConflictError(`The plan is ${plan.status}; only a draft can be written again`);
  const runId = randomUUID();
  const moved = await deps.db.contentPlan.updateMany({
    where: { id, organisationId, status: 'DRAFT' },
    data: {
      status: 'DRAFTING',
      draftError: null,
      metadata: { ...((plan.metadata as object | null) ?? {}), draftRunId: runId },
    },
  });
  if (moved.count === 0) throw new ConflictError('The plan changed; reload and try again');
  await enqueueDraft(deps.queue, plan, runId, toPlanTier(plan.planTier ?? undefined));
  return findPlan(deps.db, organisationId, id);
}

export async function listPlans(
  db: Pick<Db, 'contentPlan'>,
  organisationId: string,
  query: z.infer<typeof listPlansQuery>,
) {
  const plans = await db.contentPlan.findMany({
    where: { organisationId, ...(query.businessId && { businessId: query.businessId }) },
    include: { items: { orderBy: [{ slotAt: 'asc' }, { position: 'asc' }] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return plans.map((p) => {
    const full = publicPlan(p);
    const { items: _items, ...summary } = full;
    void _items;
    return summary;
  });
}

// ------------------------------------------------------------------ editing a draft

function assertDraft(plan: ContentPlan) {
  if (plan.status !== 'DRAFT')
    throw new ConflictError(`The plan is ${plan.status}; it can no longer be edited this way`, {
      status: plan.status,
    });
}

function findItem(plan: PlanWithItems, itemId: string): ContentPlanItem {
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError('Plan item not found');
  return item;
}

/** PATCH a draft item's topic, brief, kind or slide text. */
export async function updateDraftItem(
  db: Db,
  plan: PlanWithItems,
  itemId: string,
  input: z.infer<typeof updateItemInput>,
) {
  assertDraft(plan);
  const item = findItem(plan, itemId);
  if (item.status !== 'PLANNED') throw new ConflictError('This item can no longer be edited');
  await db.contentPlanItem.update({
    where: { id: item.id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.brief !== undefined && { brief: input.brief }),
      ...(input.kind !== undefined && { kind: input.kind }),
      ...(input.slides !== undefined && {
        slides: input.slides as unknown as Prisma.InputJsonValue,
      }),
    },
  });
}

/** POST /content-plans/:id/items — add a post at a free time inside the window (≤ 4 a day). */
export async function addDraftItem(
  deps: Pick<PlanDeps, 'db' | 'now'>,
  plan: PlanWithItems,
  input: z.infer<typeof addItemInput>,
) {
  assertDraft(plan);
  const at = Date.parse(input.slotAt);
  const now = deps.now();
  const { windowStart, windowEnd } = plan;
  if (at < windowStart.getTime() || at >= windowEnd.getTime())
    throw new ValidationError('The time must be inside the plan’s dates');
  if (availableSlots([at], [], now).length === 0)
    throw new ValidationError('The time is too soon to generate the post first');
  const live = liveItems(plan.items);
  if (live.some((i) => i.slotAt.getTime() === at))
    throw new ConflictError('Another post in this plan already has that time');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: plan.timezone }).format(new Date(at));
  const sameDay = live.filter(
    (i) => new Intl.DateTimeFormat('en-CA', { timeZone: plan.timezone }).format(i.slotAt) === day,
  );
  if (sameDay.length >= MAX_POSTS_PER_DAY)
    throw new ValidationError(`At most ${MAX_POSTS_PER_DAY} posts a day`, {
      max: MAX_POSTS_PER_DAY,
    });
  const held = await heldSlots(
    deps.db,
    { organisationId: plan.organisationId, businessId: plan.businessId },
    at,
  );
  if (held.some((h) => h.slotAt.getTime() === at))
    throw new ConflictError('Another video already posts at that time');
  const position = Math.max(-1, ...plan.items.map((i) => i.position)) + 1;
  return deps.db.contentPlanItem.create({
    data: {
      planId: plan.id,
      organisationId: plan.organisationId,
      position,
      slotAt: new Date(at),
      kind: input.kind,
      angle: 'custom',
      title: input.title,
      brief: input.brief,
      slides: (input.slides ?? {
        hook: input.title,
        points: [input.title],
        cta: '',
      }) as unknown as Prisma.InputJsonValue,
    },
  });
}

/** DELETE a draft item (it was never generated; the row goes). */
export async function deleteDraftItem(db: Db, plan: PlanWithItems, itemId: string) {
  assertDraft(plan);
  const item = findItem(plan, itemId);
  await db.contentPlanItem.delete({ where: { id: item.id } });
}

/**
 * POST /content-plans/:id/reorder — the post times stay where they are and the topics move: the
 * n-th id in `itemIds` takes the n-th earliest time (every draft item exactly once).
 */
export async function reorderDraft(
  db: Db,
  plan: PlanWithItems,
  input: z.infer<typeof reorderInput>,
) {
  assertDraft(plan);
  const planned = plan.items.filter((i) => i.status === 'PLANNED');
  const ids = new Set(input.itemIds);
  if (
    ids.size !== input.itemIds.length ||
    planned.length !== ids.size ||
    planned.some((i) => !ids.has(i.id))
  )
    throw new ValidationError('itemIds must list every item of the draft exactly once');
  const times = planned.map((i) => i.slotAt).sort((a, b) => a.getTime() - b.getTime());
  await db.$transaction(
    input.itemIds.map((id, position) =>
      db.contentPlanItem.update({ where: { id }, data: { slotAt: times[position]!, position } }),
    ),
  );
}

/** POST /content-plans/:id/items/:itemId/regenerate — one new topic for one draft item. */
export async function regenerateDraftItem(
  deps: Pick<PlanDeps, 'db' | 'now'> & { generate: PlanGenerator },
  plan: PlanWithItems,
  itemId: string,
) {
  assertDraft(plan);
  const item = findItem(plan, itemId);
  const count = Number((plan.metadata as { regenerations?: unknown } | null)?.regenerations ?? 0);
  if (count >= MAX_REGENERATIONS_PER_PLAN)
    throw new RateLimitError(
      `At most ${MAX_REGENERATIONS_PER_PLAN} topics can be regenerated per plan`,
      3_600,
    );
  await deps.db.contentPlan.update({
    where: { id: plan.id },
    data: {
      metadata: {
        ...((plan.metadata as object | null) ?? {}),
        regenerations: count + 1,
      } as Prisma.InputJsonValue,
    },
  });
  const context = await loadPlanContext(deps.db, plan, deps.now());
  // The replaced topic is listed too, so the new one is different.
  const others = plan.items.filter((i) => i.title).map((i) => i.title);
  await writeTopics(deps, plan, [item], context, others);
  return findPlan(deps.db, plan.organisationId, plan.id);
}

export type { PlanAllowance, PlanCost };
