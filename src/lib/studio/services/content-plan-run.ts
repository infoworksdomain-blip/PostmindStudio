import { Prisma, type ContentPlan, type ContentPlanItem, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { z } from 'zod';
import {
  ConflictError,
  CostCapPausedError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
} from '../../errors';
import type { AuthMailer } from '../../email/auth-mailer';
import { hasCapability, StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import { mergeMetadata } from '../automation/approval';
import type { KillSwitch } from '../kill-switch';
import { PLATFORM_RULES } from '../platforms/rules';
import { ACTIVE_PIPELINE_STATES, projectMetadata } from '../pipeline/project-state';
import type { QualityCheck } from '../pipeline/quality-checks';
import { pendingSafetyReview } from '../pipeline/safety-review';
import type { ProviderRegistry } from '../providers/registry';
import type { BudgetChecker } from '../providers/router';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { jobIds, type JobQueue } from '../queue/enqueue';
import { PLATFORM_ORGANISATION } from '../cost/guard';
import { PLAN_MIN_LEAD_MS } from '../content-plans/slots';
import {
  FINAL_ITEM_STATUSES,
  isSettled,
  itemStatusFromProject,
  type ProjectSnapshot,
} from '../content-plans/status';
import { toPlanTier, type Platform } from './catalog';
import { DEFAULT_POSTS } from '../carousel/constants';
import { CAROUSEL_PLATFORMS } from '../carousel/publishing';
import { findPlan, planTargets, type PlanWithItems, type updateItemInput } from './content-plans';
import {
  checkGenerateQuota,
  releaseQuotaReservation,
  tierQuota,
  type QuotaReservation,
} from './plan-quotas';
import { cancelProject, createProject, createProjectInput, generateProject } from './projects';
import { ugcForPlanItem } from '../ugc/plan-month';
import { automationItemBody } from './automation-items';
import { cancelPublication } from './publications';
import { monthWindow } from './tier-gates';

// 20.9 — "Generate and schedule". The request (with the owner's tenant context) creates one
// project per item through the normal createProject path — VIDEO as a BRIEF project, SLIDESHOW
// as a custom slideshow of text cards — with reviewPolicy AUTO_APPROVE, publishPolicy SCHEDULED
// at the item's post time and the plan's targets, and reserves the allowance for each item under
// the per-(org, month) quota lock (plan-quotas.ts checkGenerateQuota, top-up credits included).
// The first item the allowance cannot cover stops the run cleanly: it and every later item are
// SKIPPED with reason "allowance".
//
// Generation is throttled by the advance-content-plans job (every minute, and kicked right after
// the request): at most STUDIO_CONTENT_PLAN_CONCURRENCY items of a plan generate at once, as
// low-priority batch jobs; an optional platform-wide daily start limit
// (STUDIO_CONTENT_PLAN_DAILY_STARTS) caps provider usage; the kill switch and the cost caps hold the plan (holdReason) without failing it.
// Everything is DB state, so a crashed worker or request resumes where it stopped.
//
// Review window: each item publishes at its time unless the owner removes it (the scheduled
// publication is cancelled, pending auto-publish rows are dropped, the slot is freed) or swaps it
// for another topic (a new project replaces the old one at the same time). Items that fail
// content safety are HELD and never published; they are flagged on the plan.

/** The runner's repeat pattern (scripts/worker.ts): every minute, like the outbox dispatcher. */
export const CONTENT_PLAN_RUNNER_SCHEDULE = '* * * * *';
export const DEFAULT_PLAN_CONCURRENCY = 2;
export const MAX_PLAN_CONCURRENCY = 10;
/** A queued item is skipped when its post time is closer than this (no time to generate). */
export const START_CUTOFF_MS = 45 * 60_000;
/** Generating plans per organisation at once. */
export const MAX_GENERATING_PLANS = 3;
/**
 * Seconds of a planned video: DECISION 15 s, the short end of the "15 to 30 seconds" the plan
 * prompt asks for (least AI clip time, so the cheapest video), never past the tier's short length.
 */
export const PLAN_VIDEO_SEC = 15;
const DAY_MS = 86_400_000;

type Env = Record<string, string | undefined>;

export function planConcurrency(env: Env = process.env): number {
  const raw = Number(env.STUDIO_CONTENT_PLAN_CONCURRENCY);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_PLAN_CONCURRENCY;
  return Math.min(MAX_PLAN_CONCURRENCY, raw);
}

/**
 * STUDIO_CONTENT_PLAN_DAILY_STARTS: items started per UTC day across the platform. A positive
 * integer, or "unlimited". Unset: unlimited (20.21: the Hive V3 default of 30 went with Hive).
 */
export function planDailyStartLimit(env: Env = process.env): number | null {
  const raw = env.STUDIO_CONTENT_PLAN_DAILY_STARTS?.trim().toLowerCase();
  if (raw === 'unlimited') return null;
  const n = Number(raw);
  if (raw && Number.isInteger(n) && n > 0) return n;
  return null;
}

/** Removing a scheduled post cancels its publication: the POST /publications/:id/cancel right. */
export function assertMayCancelPublications(tenant: Pick<TenantContext, 'capabilities'>): void {
  if (!hasCapability(tenant, StudioCapability.PublicationWrite))
    throw new ForbiddenError('Removing scheduled posts cancels their publications', {
      capability: StudioCapability.PublicationWrite,
    });
}

export function assertMayScheduleForOwner(tenant: Pick<TenantContext, 'capabilities'>): void {
  for (const capability of [StudioCapability.ProjectApprove, StudioCapability.PublicationWrite])
    if (!hasCapability(tenant, capability))
      throw new ForbiddenError(
        'Generating and scheduling a month approves and publishes its posts',
        { capability },
      );
}

// ------------------------------------------------------------------ one item → one project

interface SlideText {
  hook: string;
  points: string[];
  cta: string;
}

function slideText(item: Pick<ContentPlanItem, 'slides' | 'title'>): SlideText {
  const s = (item.slides ?? {}) as Partial<SlideText>;
  const points = Array.isArray(s.points) ? s.points.filter((p) => typeof p === 'string' && p) : [];
  return {
    hook: typeof s.hook === 'string' && s.hook ? s.hook : item.title,
    points: points.length ? points.slice(0, 5) : [item.title],
    cta: typeof s.cta === 'string' ? s.cta : '',
  };
}

/** 20.26: photo slides last as long as the text cards did (2.5 s, the Ken Burns minimum). */
export const PLAN_PHOTO_SLIDE_SEC = 2.5;
/** Ken Burns moves cycled across a plan slideshow's photo slides (Shotstack clip `effect`). */
export const KEN_BURNS_CYCLE = ['zoomIn', 'slideLeft', 'zoomOut', 'slideRight'] as const;

/** The POST /projects body for one item (validated by createProjectInput like any other). */
export function projectBodyFor(
  plan: Pick<
    ContentPlan,
    'businessId' | 'platforms' | 'language' | 'brandKitId' | 'targets' | 'metadata'
  > &
    Partial<Pick<ContentPlan, 'automationId'>>,
  item: Pick<ContentPlanItem, 'kind' | 'title' | 'brief' | 'slides' | 'slotAt' | 'angle'> &
    Partial<Pick<ContentPlanItem, 'format'>>,
  shortMaxSec: number,
): z.input<typeof createProjectInput> {
  // 22.5: an automation slot is made in its format and posted only where the format goes.
  if (plan.automationId && item.format) {
    const body = automationItemBody(plan, { ...item, format: item.format }, shortMaxSec);
    if (body) return body;
  }
  const durationSec = Math.max(5, Math.min(PLAN_VIDEO_SEC, shortMaxSec));
  const targetFormats = plan.platforms.map((platform) => ({
    platform: platform as Platform,
    aspectRatio: PLATFORM_RULES[platform as Platform].aspectRatios[0]!,
    durationSec,
  }));
  const text = slideText(item);
  // 21.6: a carousel goes only to the plan's networks that take carousels (feed, LinkedIn, TikTok).
  const targets = planTargets(plan).filter(
    (target) =>
      item.kind !== 'CAROUSEL' || CAROUSEL_PLATFORMS.includes(target.platform as Platform),
  );
  // 20.12 DECISION: a plan with no connected account cannot auto-post, so its posts are made
  // and saved for review (REQUIRE_APPROVAL, MANUAL, no time) instead of failing to schedule.
  const posting = targets.length > 0;
  const common = {
    name: item.title.slice(0, 200),
    businessId: plan.businessId,
    targetFormats,
    language: plan.language,
    ...(posting
      ? {
          reviewPolicy: 'AUTO_APPROVE' as const,
          publishPolicy: 'SCHEDULED' as const,
          scheduledStartAt: item.slotAt.toISOString(),
          autoPublish: { targets },
        }
      : { reviewPolicy: 'REQUIRE_APPROVAL' as const, publishPolicy: 'MANUAL' as const }),
    ...(plan.brandKitId && { brandKitId: plan.brandKitId }),
  };
  if (item.kind === 'CAROUSEL') {
    // 21.6: Studio writes the thread from the item's title and brief when it is generated.
    const { targetFormats: _formats, ...rest } = common;
    void _formats;
    return {
      ...rest,
      sourceType: 'CAROUSEL',
      brief: {
        rawInput: `${item.title}\n\n${item.brief}`.slice(0, 4_000),
        ...(text.cta && { callToAction: text.cta.slice(0, 200) }),
      },
      carousel: { theme: 'light', postCount: DEFAULT_POSTS },
    };
  }
  if (item.kind === 'SLIDESHOW') {
    const card = (role: 'hook' | 'cta', value: string) => ({
      slideType: 'TEXT_CARD' as const,
      content: { role, text: value.slice(0, 300) },
    });
    // 20.26: each point is a photo slide (its text as the caption) with a Ken Burns move; the
    // image is found when the slideshow is generated (plan-slideshow.ts: library, then stock,
    // then a generated image), and a point with no image left becomes a text card.
    const photo = (value: string, index: number) => ({
      slideType: 'IMAGE_KENBURNS' as const,
      durationSec: PLAN_PHOTO_SLIDE_SEC,
      transitionIn: 'fade' as const,
      kenBurnsSpec: { effect: KEN_BURNS_CYCLE[index % KEN_BURNS_CYCLE.length]! },
      content: {
        role: 'body' as const,
        text: value.slice(0, 300),
        imageQuery: value.slice(0, 300),
      },
    });
    return {
      ...common,
      sourceType: 'SLIDESHOW',
      slideshow: {
        topic: item.title.slice(0, 500),
        slides: [
          card('hook', text.hook),
          ...text.points.map(photo),
          ...(text.cta ? [card('cta', text.cta)] : []),
        ],
      },
    };
  }
  // 21.4: testimonial and product videos of a plan with UGC actors on (ugc/plan-month.ts).
  const ugc = ugcForPlanItem(plan, item);
  return {
    ...common,
    sourceType: 'BRIEF',
    ...(ugc && { ugc }),
    brief: {
      rawInput: `${item.title}\n\n${item.brief}`.slice(0, 4_000),
      ...(text.cta && { callToAction: text.cta.slice(0, 200) }),
    },
  };
}

export interface PrepareDeps {
  db: PrismaClient;
  logger: Logger;
  now: () => number;
  env?: Env;
  entitlements?: EntitlementsReader;
}

type PrepareOutcome = 'queued' | 'allowance' | 'slot_passed';

/**
 * Create the item's project (once: the project id is stored before the quota check, so a retried
 * request reuses it) and reserve its allowance. QuotaExceededError → the project is archived and
 * the item SKIPPED ('allowance').
 */
export async function prepareItem(
  deps: PrepareDeps,
  tenant: TenantContext,
  plan: ContentPlan,
  item: ContentPlanItem,
): Promise<PrepareOutcome> {
  const now = deps.now();
  if (item.slotAt.getTime() < now + PLAN_MIN_LEAD_MS) {
    await setItem(deps.db, item.id, { status: 'SKIPPED', statusReason: 'slot_passed' });
    return 'slot_passed';
  }
  let projectId = item.projectId;
  if (!projectId) {
    const tier = toPlanTier(tenant.organisation.planTier);
    const quota = tierQuota(tier, deps.env);
    const input = createProjectInput.parse(projectBodyFor(plan, item, quota.shortMaxSec));
    const project = await createProject(deps.db, tenant, input, now);
    await mergeMetadata(deps.db, project.id, {
      // Pre-approved (auto-posted at its time) only when the plan has an account to post to.
      contentPlan: { planId: plan.id, itemId: item.id, preApproved: planTargets(plan).length > 0 },
      // 20.13: the plan's caption + hashtags (drafted, maybe edited) become the project's copy.
      ...(item.postCopy && { postCopy: item.postCopy }),
    });
    projectId = project.id;
    await setItem(deps.db, item.id, { projectId });
  }
  let reservation: QuotaReservation | undefined;
  try {
    reservation =
      (await checkGenerateQuota(deps, tenant, projectId)).reservation ??
      (await markSlot(deps, tenant.organisationId, projectId, now));
  } catch (err) {
    if (!(err instanceof QuotaExceededError)) throw err;
    await archiveDraftProject(deps.db, tenant.organisationId, projectId, now);
    await setItem(deps.db, item.id, { status: 'SKIPPED', statusReason: 'allowance' });
    return 'allowance';
  }
  await setItem(deps.db, item.id, {
    status: 'QUEUED',
    statusReason: null,
    quotaReservation: reservation
      ? ({
          month: reservation.month,
          fresh: reservation.fresh,
          ...(reservation.creditUseId && { creditUseId: reservation.creditUseId }),
        } as Prisma.InputJsonValue)
      : undefined,
  });
  return 'queued';
}

/**
 * Without billing entitlements (core mode) the quota check reserves nothing, so a plan's items
 * prepared in one request would not count each other. Record the same metadata.quotaSlot the
 * locked check writes, so each item counts against the month from now on (and can be given back
 * with releaseQuotaReservation when it never runs).
 */
async function markSlot(
  deps: Pick<PrepareDeps, 'db'>,
  organisationId: string,
  projectId: string,
  now: number,
): Promise<QuotaReservation> {
  const month = monthWindow(now).key;
  await mergeMetadata(deps.db, projectId, {
    quotaSlot: { month, kind: 'short', at: new Date(now).toISOString() },
  });
  return { projectId, organisationId, month, fresh: true };
}

function setItem(
  db: Pick<PrismaClient, 'contentPlanItem'>,
  id: string,
  data: Prisma.ContentPlanItemUncheckedUpdateInput,
) {
  return db.contentPlanItem.update({ where: { id }, data });
}

async function archiveDraftProject(
  db: Pick<PrismaClient, 'videoProject'>,
  organisationId: string,
  projectId: string,
  now: number,
) {
  await db.videoProject.updateMany({
    where: { id: projectId, organisationId, state: 'DRAFT' },
    data: { state: 'ARCHIVED', deletedAt: new Date(now) },
  });
}

function storedReservation(
  item: Pick<ContentPlanItem, 'quotaReservation' | 'projectId' | 'organisationId'>,
): QuotaReservation | undefined {
  const r = item.quotaReservation as {
    month?: unknown;
    fresh?: unknown;
    creditUseId?: unknown;
  } | null;
  if (!r || typeof r.month !== 'string' || !item.projectId) return undefined;
  return {
    projectId: item.projectId,
    organisationId: item.organisationId,
    month: r.month,
    fresh: r.fresh === true,
    ...(typeof r.creditUseId === 'string' && { creditUseId: r.creditUseId }),
  };
}

// ------------------------------------------------------------------ generate and schedule

async function prepareAll(deps: PrepareDeps, tenant: TenantContext, planId: string) {
  const plan = await findPlan(deps.db, tenant.organisationId, planId);
  let stopped = false;
  for (const item of plan.items) {
    if (item.status !== 'PLANNED') continue;
    if (stopped) {
      await setItem(deps.db, item.id, { status: 'SKIPPED', statusReason: 'allowance' });
      continue;
    }
    if ((await prepareItem(deps, tenant, plan, item)) === 'allowance') stopped = true;
  }
  if (stopped)
    await deps.db.contentPlan.update({
      where: { id: planId },
      data: { cappedReason: 'allowance' },
    });
}

/** Kick the runner for one plan now (the every-minute sweep would pick it up anyway). */
export async function kickPlan(
  queue: JobQueue,
  plan: Pick<ContentPlan, 'id'>,
  now: number,
): Promise<void> {
  // Platform-level like the every-minute sweep: the runner checks each plan's own kill switch.
  await queue.add(
    'advance-content-plans',
    {
      organisationId: PLATFORM_ORGANISATION,
      runId: `plan-${plan.id}`,
      planTier: 'STANDARD',
      planId: plan.id,
    },
    { jobId: jobIds.advanceContentPlan(plan.id, now) },
  );
}

/** POST /content-plans/:id/generate — DRAFT → GENERATING (or resume a GENERATING plan). */
export async function generatePlan(
  deps: PrepareDeps & { queue: JobQueue },
  tenant: TenantContext,
  planId: string,
) {
  assertMayScheduleForOwner(tenant);
  const plan = await findPlan(deps.db, tenant.organisationId, planId);
  if (plan.status !== 'DRAFT' && plan.status !== 'GENERATING')
    throw new ConflictError(`The plan is ${plan.status}`, { status: plan.status });
  if (plan.status === 'DRAFT') {
    const planned = plan.items.filter((i) => i.status === 'PLANNED');
    if (planned.length === 0) throw new ConflictError('The plan has no posts to generate');
    if (planned.some((i) => !i.title || !i.brief))
      throw new ConflictError('Some posts have no topic yet; write them first', {
        code: 'untitled_items',
      });
    const running = await deps.db.contentPlan.count({
      where: { organisationId: tenant.organisationId, status: 'GENERATING' },
    });
    if (running >= MAX_GENERATING_PLANS)
      throw new RateLimitError(
        `At most ${MAX_GENERATING_PLANS} month plans can generate at once`,
        600,
      );
    const moved = await deps.db.contentPlan.updateMany({
      where: { id: plan.id, organisationId: tenant.organisationId, status: 'DRAFT' },
      data: {
        status: 'GENERATING',
        scheduledByUserId: tenant.userId,
        planTier: toPlanTier(tenant.organisation.planTier),
        generationStartedAt: new Date(deps.now()),
        holdReason: null,
      },
    });
    if (moved.count === 0) throw new ConflictError('The plan changed; reload and try again');
  }
  await prepareAll(deps, tenant, plan.id);
  await kickPlan(deps.queue, plan, deps.now());
  return findPlan(deps.db, tenant.organisationId, plan.id);
}

// ------------------------------------------------------------------ keeping item status in step

const CONTENT_SAFETY_FAILED = (issues: Prisma.JsonValue | null) =>
  Array.isArray(issues) &&
  (issues as unknown as QualityCheck[]).some(
    (c) => c?.code === 'content_safety' && c.status === 'failed',
  );

/** Read each generated item's project and update its status (and reason) when it changed. */
export async function syncPlanItems(
  db: Pick<PrismaClient, 'contentPlanItem' | 'videoProject' | 'autoPublishOutbox'>,
  planId: string,
): Promise<number> {
  // PLANNED items with a project are mid-preparation (no allowance reserved yet): generate
  // finishes them, never the sync.
  const items = await db.contentPlanItem.findMany({
    where: {
      planId,
      projectId: { not: null },
      status: { notIn: [...FINAL_ITEM_STATUSES, 'PLANNED'] },
    },
  });
  if (items.length === 0) return 0;
  const ids = items.map((i) => i.projectId!);
  const [projects, outbox] = await Promise.all([
    db.videoProject.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        state: true,
        errorReason: true,
        metadata: true,
        publications: { select: { state: true } },
        renders: { select: { qualityIssues: true } },
      },
    }),
    db.autoPublishOutbox.groupBy({
      by: ['projectId'],
      where: { projectId: { in: ids }, state: { in: ['PENDING', 'SENDING'] } },
      _count: { _all: true },
    }),
  ]);
  const pending = new Map(outbox.map((o) => [o.projectId, o._count._all]));
  const byId = new Map(projects.map((p) => [p.id, p]));
  let changed = 0;
  for (const item of items) {
    const p = byId.get(item.projectId!);
    if (!p) continue;
    const review = projectMetadata(p.metadata).review as { code?: unknown } | undefined;
    const snapshot: ProjectSnapshot = {
      state: p.state,
      errorReason: p.errorReason,
      reviewCode: typeof review?.code === 'string' ? review.code : null,
      safetyReviewPending: Boolean(pendingSafetyReview(p.metadata)),
      contentSafetyFailed: p.renders.some((r) => CONTENT_SAFETY_FAILED(r.qualityIssues)),
      publications: p.publications,
      pendingOutbox: pending.get(p.id) ?? 0,
    };
    const next = itemStatusFromProject(snapshot);
    // A queued item whose project is still a draft stays QUEUED until the runner starts it.
    if (item.status === 'QUEUED' && next.status === 'QUEUED') continue;
    if (next.status === item.status && next.reason === item.statusReason) continue;
    await setItem(db, item.id, { status: next.status, statusReason: next.reason });
    changed += 1;
  }
  return changed;
}

// ------------------------------------------------------------------ the runner

export interface RunnerDeps {
  db: PrismaClient;
  queue: JobQueue;
  logger: Logger;
  now: () => number;
  killSwitch: Pick<KillSwitch, 'check'>;
  budget?: Pick<BudgetChecker, 'assertNotPaused'>;
  mailer?: AuthMailer;
  appUrl?: string;
  env?: Env;
}

export interface AdvanceResult {
  plans: number;
  started: number;
  scheduled: number;
  completed: number;
}

const PLAN_BATCH = 50;

/** The advance-content-plans job: every generating / scheduled plan (or just `planId`). */
export async function advanceContentPlans(
  deps: RunnerDeps,
  filter: { planId?: string } = {},
): Promise<AdvanceResult> {
  const plans = await deps.db.contentPlan.findMany({
    where: {
      status: { in: ['GENERATING', 'SCHEDULED'] },
      ...(filter.planId && { id: filter.planId }),
    },
    orderBy: { updatedAt: 'asc' },
    take: PLAN_BATCH,
  });
  const result: AdvanceResult = { plans: plans.length, started: 0, scheduled: 0, completed: 0 };
  for (const plan of plans) {
    try {
      const outcome = await advancePlan(deps, plan);
      result.started += outcome.started;
      if (outcome.status === 'SCHEDULED' && plan.status === 'GENERATING') result.scheduled += 1;
      if (outcome.status === 'COMPLETED') result.completed += 1;
    } catch (err) {
      deps.logger.error(
        { err, planId: plan.id, organisationId: plan.organisationId },
        'month plan could not advance',
      );
    }
  }
  return result;
}

async function advancePlan(
  deps: RunnerDeps,
  plan: ContentPlan,
): Promise<{ started: number; status: ContentPlan['status'] }> {
  await syncPlanItems(deps.db, plan.id);
  let started = 0;
  if (plan.status === 'GENERATING') started = await startItems(deps, plan);
  const items = await deps.db.contentPlanItem.findMany({ where: { planId: plan.id } });
  if (plan.status === 'GENERATING' && items.every((i) => isSettled(i.status))) {
    const moved = await deps.db.contentPlan.updateMany({
      where: { id: plan.id, status: 'GENERATING' },
      data: { status: 'SCHEDULED', scheduledAt: new Date(deps.now()), holdReason: null },
    });
    if (moved.count === 1) {
      await sendSummary(deps, plan, items);
      return { started, status: 'SCHEDULED' };
    }
  }
  if (plan.status === 'SCHEDULED') {
    const last = Math.max(0, ...items.map((i) => i.slotAt.getTime()));
    const open = items.some(
      (i) => i.status === 'SCHEDULED' || i.status === 'READY' || !isSettled(i.status),
    );
    if (!open || last < deps.now() - DAY_MS) {
      await deps.db.contentPlan.updateMany({
        where: { id: plan.id, status: 'SCHEDULED' },
        data: { status: 'COMPLETED', completedAt: new Date(deps.now()) },
      });
      return { started, status: 'COMPLETED' };
    }
  }
  return { started, status: plan.status };
}

async function hold(db: PrismaClient, plan: ContentPlan, reason: string | null) {
  if (plan.holdReason === reason) return;
  await db.contentPlan.update({ where: { id: plan.id }, data: { holdReason: reason } });
}

function utcDayStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function startItems(deps: RunnerDeps, plan: ContentPlan): Promise<number> {
  const scope = { organisationId: plan.organisationId };
  const planTier = toPlanTier(plan.planTier ?? undefined);
  const kill = await deps.killSwitch.check(scope);
  if (kill.killed) {
    await hold(deps.db, plan, 'kill_switch');
    return 0;
  }
  // 22.5: a paused automation starts no new generation (posts already made still go out).
  if ((plan.metadata as { paused?: unknown } | null)?.paused === true) {
    await hold(deps.db, plan, 'paused');
    return 0;
  }
  try {
    await deps.budget?.assertNotPaused?.({ organisationId: plan.organisationId, planTier });
  } catch (err) {
    if (!(err instanceof CostCapPausedError)) throw err;
    await hold(deps.db, plan, 'cost_cap');
    return 0;
  }
  const items = await deps.db.contentPlanItem.findMany({
    where: { planId: plan.id, status: { in: ['QUEUED', 'GENERATING'] } },
    orderBy: [{ slotAt: 'asc' }, { position: 'asc' }],
  });
  let free = planConcurrency(deps.env) - items.filter((i) => i.status === 'GENERATING').length;
  const limit = planDailyStartLimit(deps.env);
  if (limit !== null) {
    const today = await deps.db.contentPlanItem.count({
      where: { startedAt: { gte: utcDayStart(deps.now()) } },
    });
    if (today >= limit && items.some((i) => i.status === 'QUEUED')) {
      await hold(deps.db, plan, 'daily_limit');
      return 0;
    }
    free = Math.min(free, limit - today);
  }
  let started = 0;
  const tenant = {
    organisationId: plan.organisationId,
    organisation: { id: plan.organisationId, planTier },
  };
  for (const item of items) {
    if (started >= free) break;
    if (item.status !== 'QUEUED' || !item.projectId) continue;
    if (item.slotAt.getTime() < deps.now() + START_CUTOFF_MS) {
      await skipItem(deps, item, 'slot_passed');
      continue;
    }
    try {
      await generateProject(deps, tenant, item.projectId, {}, { batch: true });
      await setItem(deps.db, item.id, {
        status: 'GENERATING',
        statusReason: null,
        startedAt: new Date(deps.now()),
      });
      started += 1;
    } catch (err) {
      deps.logger.warn({ err, planId: plan.id, itemId: item.id }, 'month plan item did not start');
      await setItem(deps.db, item.id, { status: 'FAILED', statusReason: 'not_started' });
    }
  }
  await hold(deps.db, plan, null);
  return started;
}

/** A queued item that will not run: give its allowance back and archive its draft project. */
async function skipItem(
  deps: Pick<RunnerDeps, 'db' | 'logger' | 'now'>,
  item: ContentPlanItem,
  reason: string,
) {
  await releaseQuotaReservation(deps, storedReservation(item));
  if (item.projectId)
    await archiveDraftProject(deps.db, item.organisationId, item.projectId, deps.now());
  await setItem(deps.db, item.id, { status: 'SKIPPED', statusReason: reason });
}

/** The ONE summary email, to whoever pressed "Generate and schedule" (standalone users only). */
async function sendSummary(deps: RunnerDeps, plan: ContentPlan, items: ContentPlanItem[]) {
  const claimed = await deps.db.contentPlan.updateMany({
    where: { id: plan.id, summaryEmailedAt: null },
    data: { summaryEmailedAt: new Date(deps.now()) },
  });
  if (claimed.count === 0) return;
  const userId = plan.scheduledByUserId ?? plan.createdByUserId;
  const user = await deps.db.user.findUnique({
    where: { id: userId },
    select: { email: true, locale: true, deletedAt: true },
  });
  if (!deps.mailer || !deps.appUrl || !user || user.deletedAt) {
    deps.logger.info(
      { planId: plan.id, userId },
      'month plan summary email not sent (no mailer, app URL or user)',
    );
    return;
  }
  const count = (s: ContentPlanItem['status']) => items.filter((i) => i.status === s).length;
  // Dates as noon UTC of the plan's local days, so every reader's locale shows the same day.
  const lastDay = new Date(Date.parse(`${plan.startDate}T12:00:00Z`) + (plan.days - 1) * DAY_MS);
  try {
    await deps.mailer.sendAuthEmail(
      'monthPlanned',
      user.email,
      {
        url: `${deps.appUrl.replace(/\/$/, '')}/plans/${plan.id}`,
        postCount: count('SCHEDULED'),
        needsAttention: count('READY') + count('HELD') + count('FAILED'),
        startDate: `${plan.startDate}T12:00:00.000Z`,
        endDate: lastDay.toISOString(),
      },
      user.locale ?? 'en-GB',
      {
        idempotencyKey: `month-planned:${plan.id}`,
        organisationId: plan.organisationId,
        userId,
      },
    );
  } catch (err) {
    deps.logger.error({ err, planId: plan.id }, 'month plan summary email could not be queued');
  }
}

// ------------------------------------------------------------------ review window: remove, swap, cancel

export interface DetachDeps {
  db: PrismaClient;
  registry: ProviderRegistry;
  logger: Logger;
  now: () => number;
}

/**
 * Take an item's project out of the schedule: stop its generation, cancel its scheduled
 * publications, drop pending auto-publish rows and turn auto-publishing off (so a later approval
 * posts nothing), and give an unused allowance reservation back. Conflict when it is posting now.
 */
export async function detachItem(deps: DetachDeps, item: ContentPlanItem): Promise<void> {
  if (!item.projectId) return;
  const project = await deps.db.videoProject.findFirst({
    where: { id: item.projectId, organisationId: item.organisationId },
    include: { publications: { select: { id: true, state: true } } },
  });
  if (!project) return;
  if (project.publications.some((p) => p.state === 'PUBLISHING' || p.state === 'PUBLISHED'))
    throw new ConflictError('This post is already being published', { itemId: item.id });
  if (ACTIVE_PIPELINE_STATES.includes(project.state)) {
    try {
      await cancelProject(deps, item.organisationId, project.id);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  for (const pub of project.publications.filter((p) => p.state === 'SCHEDULED')) {
    try {
      await cancelPublication(deps.db, item.organisationId, pub.id);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      throw new ConflictError('This post is already being published', { itemId: item.id });
    }
  }
  await deps.db.autoPublishOutbox.deleteMany({
    where: { projectId: project.id, state: 'PENDING' },
  });
  await deps.db.videoProject.updateMany({
    where: { id: project.id, organisationId: item.organisationId },
    data: { publishPolicy: 'MANUAL' },
  });
  await mergeMetadata(deps.db, project.id, {
    contentPlan: {
      ...((projectMetadata(project.metadata).contentPlan as object | undefined) ?? {}),
      preApproved: false,
      removed: true,
    },
  });
  if (project.state === 'DRAFT') {
    await releaseQuotaReservation(deps, storedReservation(item));
    await archiveDraftProject(deps.db, item.organisationId, project.id, deps.now());
  }
}

function assertOpenItem(item: ContentPlanItem, now: number) {
  if (FINAL_ITEM_STATUSES.has(item.status))
    throw new ConflictError(`This post is ${item.status.toLowerCase()}`, { status: item.status });
  if (item.slotAt.getTime() <= now && item.status === 'SCHEDULED')
    throw new ConflictError('This post’s time has passed');
}

/** DELETE an item of a generating / scheduled plan: cancel it and free its time. */
export async function removeScheduledItem(
  deps: DetachDeps,
  tenant: Pick<TenantContext, 'capabilities'>,
  plan: PlanWithItems,
  itemId: string,
) {
  assertMayCancelPublications(tenant);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError('Plan item not found');
  assertOpenItem(item, deps.now());
  await detachItem(deps, item);
  await setItem(deps.db, item.id, { status: 'REMOVED', statusReason: 'removed_by_owner' });
}

/**
 * PATCH an item of a generating / scheduled plan: swap it for another topic or kind at the same
 * time. The old project is detached and a new one prepared (allowance checked again).
 */
export async function swapScheduledItem(
  deps: DetachDeps & PrepareDeps & { queue: JobQueue },
  tenant: TenantContext,
  plan: PlanWithItems,
  itemId: string,
  input: z.infer<typeof updateItemInput>,
) {
  assertMayScheduleForOwner(tenant);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError('Plan item not found');
  assertOpenItem(item, deps.now());
  await detachItem(deps, item);
  const updated = await setItem(deps.db, item.id, {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.brief !== undefined && { brief: input.brief }),
    ...(input.kind !== undefined && { kind: input.kind }),
    ...(input.slides !== undefined && { slides: input.slides as unknown as Prisma.InputJsonValue }),
    status: 'PLANNED',
    statusReason: null,
    projectId: null,
    quotaReservation: Prisma.DbNull,
    startedAt: null,
  });
  const outcome = await prepareItem(deps, tenant, plan, updated);
  if (outcome === 'queued')
    await deps.db.contentPlan.updateMany({
      where: { id: plan.id, status: 'SCHEDULED' },
      data: { status: 'GENERATING' },
    });
  await kickPlan(deps.queue, plan, deps.now());
  return { outcome };
}

/** POST /content-plans/:id/cancel — every post not yet out is cancelled; the plan ends. */
export async function cancelPlan(
  deps: DetachDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'capabilities'>,
  planId: string,
) {
  const organisationId = tenant.organisationId;
  const plan = await findPlan(deps.db, organisationId, planId);
  // Cancelling a generating / scheduled plan cancels publications (like POST /publications/:id/cancel).
  if (plan.status === 'GENERATING' || plan.status === 'SCHEDULED')
    assertMayCancelPublications(tenant);
  if (plan.status === 'CANCELLED' || plan.status === 'COMPLETED')
    throw new ConflictError(`The plan is ${plan.status}`, { status: plan.status });
  const moved = await deps.db.contentPlan.updateMany({
    where: { id: plan.id, organisationId, status: plan.status },
    data: { status: 'CANCELLED', cancelledAt: new Date(deps.now()), holdReason: null },
  });
  if (moved.count === 0) throw new ConflictError('The plan changed; reload and try again');
  let kept = 0;
  for (const item of plan.items) {
    if (FINAL_ITEM_STATUSES.has(item.status)) continue;
    try {
      await detachItem(deps, item);
      await setItem(deps.db, item.id, { status: 'REMOVED', statusReason: 'plan_cancelled' });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      kept += 1;
    }
  }
  return { plan: await findPlan(deps.db, organisationId, planId), keptPublishing: kept };
}
