import { randomUUID } from 'node:crypto';
import type { Automation, ContentPlan, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { isValidTimeZone } from '../automation/zoned-time';
import {
  assertMayConfigureTargets,
  autoPublishTargets,
  validateTargets,
  type AutoPublishTarget,
} from '../automation/targets';
import { channelPlanForOrganisation } from '../billing/channels';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { allocateFormats, allowanceUnitsFor, keepCheapestFirst } from '../blitz/allocate';
import { availableFormats, FORMATS, platformsFor, type FormatKey } from '../blitz/formats';
import { effectiveAngleWeight, pickWeighted, type MixPreferences } from '../blitz/mix';
import { tiktokPhotoPostsVerified } from '../blitz/targets';
import { capItems, loadPlanAllowance, typicalItemCostPence } from '../content-plans/allowance';
import { type PlanKind } from '../content-plans/mix';
import {
  availableSlots,
  dailySlots,
  defaultStartDate,
  formatLocalDate,
  localDateOf,
  planWindow,
} from '../content-plans/slots';
import { weeklySlots } from '../content-plans/weekly-slots';
import { DEFAULT_LANGUAGE, languageInput } from '../languages';
import { PLATFORM_RULES } from '../platforms/rules';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import { isUgcLanguage } from '../ugc/style';
import { assertMayScheduleForOwner } from './content-plan-run';
import { listAngles } from './angles';
import { businessIdParam } from './businesses';
import { PLATFORMS, toPlanTier } from './catalog';
import { getMix } from './content-mix';
import { heldSlots } from './drip-queue';
import { featureGateFor, type Feature } from './features';

// 22.5 — weekly / monthly auto generation and posting at the lowest cost (operator brief
// 2026-10-06). An automation is a recurring "Plan my month": each period is a content_plans row
// (automationId) drafted from the business's angles and its content mix — cheapest formats first
// — then run by the month-plan machinery (services/content-plan-run.ts: throttled generation,
// allowance reservations, explicit post times, auto-publish through the outbox and drip rules).
//
// Lifecycle (Fastlane): DRAFT → GENERATING (the period's posts are being written) → REVIEW (the
// owner keeps / rerolls / edits slots, here or in Blitz) → ACTIVE (generating ahead of each slot
// and posting) → COMPLETED; PAUSED from any live state (owner, allowance used up, billing, the
// person who set it up left). "Auto-approve and post" skips REVIEW. Ongoing automations draft the
// next period AUTOMATION_PERIOD_LEAD_DAYS before the current one ends.

export const AUTOMATION_DURATIONS = [
  'one_week',
  'four_weeks',
  'ongoing_weekly',
  'ongoing_monthly',
] as const;
export type AutomationDuration = (typeof AUTOMATION_DURATIONS)[number];
export const APPROVAL_MODES = ['review', 'auto'] as const;

/** The next period is drafted (and starts generating) this long before the current one ends. */
export const AUTOMATION_PERIOD_LEAD_DAYS = 3;
export const MAX_AUTOMATIONS_PER_BUSINESS = 5;
export const MAX_POSTS_PER_DAY_PER_CHANNEL = 3;
const DAY_MS = 86_400_000;

export const cadenceSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('per_day'),
      postsPerDay: z.number().int().min(1).max(MAX_POSTS_PER_DAY_PER_CHANNEL),
    })
    .strict(),
  z.object({ mode: z.literal('per_week'), postsPerWeek: z.number().int().min(1).max(21) }).strict(),
]);
export type Cadence = z.infer<typeof cadenceSchema>;

const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'timezone must be an IANA time zone' });

export const createAutomationInput = z
  .object({
    businessId: businessIdParam,
    name: z.string().trim().min(1).max(80).optional(),
    cadence: cadenceSchema,
    duration: z.enum(AUTOMATION_DURATIONS),
    platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
    targets: autoPublishTargets.default([]),
    approvalMode: z.enum(APPROVAL_MODES).default('review'),
    timezone: timezone.optional(),
    language: languageInput.optional(),
    /** Internal ceiling per period (pence); staff only (the route drops it for customers). */
    costCeilingPence: z.number().int().min(0).max(10_000_000).nullable().optional(),
  })
  .strict();
export type CreateAutomationInput = z.infer<typeof createAutomationInput>;

export const updateAutomationInput = createAutomationInput
  .omit({ businessId: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listAutomationsQuery = z.object({ businessId: businessIdParam.optional() });

export interface AutomationDeps {
  db: PrismaClient;
  queue: JobQueue;
  now: () => number;
  env?: Record<string, string | undefined>;
  entitlements?: EntitlementsReader;
}

type Scope = { organisationId: string; businessId: string };

export function periodDays(duration: string): number {
  return duration === 'four_weeks' || duration === 'ongoing_monthly' ? 28 : 7;
}

export function isOngoing(duration: string): boolean {
  return duration === 'ongoing_weekly' || duration === 'ongoing_monthly';
}

export function readCadence(value: Prisma.JsonValue): Cadence {
  const parsed = cadenceSchema.safeParse(value);
  return parsed.success ? parsed.data : { mode: 'per_day', postsPerDay: 1 };
}

export function automationTargets(a: Pick<Automation, 'targets'>): AutoPublishTarget[] {
  const parsed = autoPublishTargets.safeParse(a.targets);
  return parsed.success ? parsed.data : [];
}

export async function findAutomation(
  db: Pick<PrismaClient, 'automation'>,
  organisationId: string,
  id: string,
): Promise<Automation> {
  const automation = await db.automation.findFirst({ where: { id, organisationId } });
  if (!automation) throw new NotFoundError('Automation not found');
  return automation;
}

// ------------------------------------------------------------------ create / edit

/** 21.5: an automation posts to at most as many networks as the plan has channels. */
async function assertChannels(
  db: PrismaClient,
  organisationId: string,
  platforms: readonly string[],
  now: number,
) {
  const plan = await channelPlanForOrganisation(db, organisationId, new Date(now));
  if (!plan) return;
  const networks = new Set(
    platforms.map((p) => PLATFORM_RULES[p as keyof typeof PLATFORM_RULES].connectionPlatform),
  );
  if (networks.size > plan.channels)
    throw new ValidationError(
      `Your plan includes ${plan.channels} ${plan.channels === 1 ? 'channel' : 'channels'}; choose at most that many networks`,
      { code: 'channel_limit', channels: plan.channels, networks: [...networks] },
    );
}

function defaultName(input: Pick<CreateAutomationInput, 'duration' | 'cadence'>): string {
  const cadence =
    input.cadence.mode === 'per_day'
      ? `${input.cadence.postsPerDay} a day`
      : `${input.cadence.postsPerWeek} a week`;
  const duration = {
    one_week: '1 week',
    four_weeks: '4 weeks',
    ongoing_weekly: 'every week',
    ongoing_monthly: 'every month',
  }[input.duration];
  return `${cadence}, ${duration}`;
}

/** POST /automations — a DRAFT (nothing runs until it is started). */
export async function createAutomation(
  deps: AutomationDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'userId' | 'capabilities'>,
  input: CreateAutomationInput,
): Promise<Automation> {
  const scope = { organisationId: tenant.organisationId, businessId: input.businessId };
  const live = await deps.db.automation.count({
    where: { ...scope, status: { in: ['DRAFT', 'GENERATING', 'REVIEW', 'ACTIVE', 'PAUSED'] } },
  });
  if (live >= MAX_AUTOMATIONS_PER_BUSINESS)
    throw new ConflictError(
      `A business can have at most ${MAX_AUTOMATIONS_PER_BUSINESS} automations at once`,
      { code: 'too_many_automations' },
    );
  await assertChannels(deps.db, tenant.organisationId, input.platforms, deps.now());
  assertMayConfigureTargets(tenant, input.targets);
  await validateTargets(deps.db, tenant.organisationId, input.targets, input.platforms);
  return deps.db.automation.create({
    data: {
      ...scope,
      createdByUserId: tenant.userId,
      name: input.name ?? defaultName(input),
      status: 'DRAFT',
      cadence: input.cadence as Prisma.InputJsonValue,
      duration: input.duration,
      platforms: input.platforms,
      targets: input.targets as unknown as Prisma.InputJsonValue,
      approvalMode: input.approvalMode,
      timezone: input.timezone ?? 'Europe/London',
      language: input.language ?? DEFAULT_LANGUAGE,
      costCeilingPence: input.costCeilingPence ?? null,
      capabilities: [],
    },
  });
}

/** PATCH a DRAFT automation. */
export async function updateAutomation(
  deps: AutomationDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'capabilities'>,
  id: string,
  input: z.infer<typeof updateAutomationInput>,
): Promise<Automation> {
  const automation = await findAutomation(deps.db, tenant.organisationId, id);
  if (automation.status !== 'DRAFT')
    throw new ConflictError('Only a draft automation can be changed; pause it and start a new one');
  const platforms = input.platforms ?? automation.platforms;
  if (input.platforms) await assertChannels(deps.db, tenant.organisationId, platforms, deps.now());
  if (input.targets) {
    assertMayConfigureTargets(tenant, input.targets);
    await validateTargets(deps.db, tenant.organisationId, input.targets, platforms);
  }
  return deps.db.automation.update({
    where: { id: automation.id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.cadence && { cadence: input.cadence as Prisma.InputJsonValue }),
      ...(input.duration && { duration: input.duration }),
      ...(input.platforms && { platforms: input.platforms }),
      ...(input.targets && { targets: input.targets as unknown as Prisma.InputJsonValue }),
      ...(input.approvalMode && { approvalMode: input.approvalMode }),
      ...(input.timezone && { timezone: input.timezone }),
      ...(input.language && { language: input.language }),
      ...(input.costCeilingPence !== undefined && { costCeilingPence: input.costCeilingPence }),
    },
  });
}

// ------------------------------------------------------------------ the period plan

/** Formats the automation may use: available, switched on, with a network that takes them. */
export async function allowedFormats(
  db: PrismaClient,
  automation: Pick<Automation, 'organisationId' | 'platforms' | 'language'>,
  mix: MixPreferences,
  env?: Record<string, string | undefined>,
): Promise<FormatKey[]> {
  const gate = featureGateFor(db);
  const feature: Partial<Record<FormatKey, Feature>> = {
    carousel: 'carousels',
    slideshow: 'slideshow',
  };
  const out: FormatKey[] = [];
  for (const key of availableFormats()) {
    if ((mix.formatWeights[key] ?? 0) <= 0) continue;
    if (key === 'ugc' && !isUgcLanguage(automation.language)) continue;
    const f = feature[key];
    if (f && !(await gate.status(f, automation.organisationId)).enabled) continue;
    let platforms = platformsFor(key, automation.platforms);
    // TikTok carousels need a verified slide domain (blitz/targets.ts); without it TikTok does
    // not count as a carousel network (the slot goes to a format that works there).
    if (key === 'carousel' && !tiktokPhotoPostsVerified(env))
      platforms = platforms.filter((p) => p !== 'tiktok');
    if (platforms.length === 0) continue;
    out.push(key);
  }
  return out;
}

export interface PeriodDraft {
  plan: ContentPlan | null;
  /** Why no plan (or a shorter one) was made. */
  reason: 'allowance' | 'cost_cap' | 'no_formats' | 'no_free_slots' | null;
}

function candidateSlots(automation: Automation, start: ReturnType<typeof localDateOf>) {
  const cadence = readCadence(automation.cadence);
  const days = periodDays(automation.duration);
  return cadence.mode === 'per_day'
    ? dailySlots(start, days, cadence.postsPerDay, automation.timezone)
    : weeklySlots(start, days, cadence.postsPerWeek, automation.timezone);
}

/** Angle per slot: weighted, never the same angle twice in a row when there is a choice. */
function pickAngles(
  count: number,
  angles: Array<{
    id: string;
    title: string;
    description: string;
    targetAudience: string;
    weight: number;
  }>,
  mix: MixPreferences,
  rand: () => number,
) {
  const out: Array<(typeof angles)[number] | null> = [];
  let last: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const pool = angles.length > 1 ? angles.filter((a) => a.id !== last) : angles;
    const angle = pickWeighted(
      pool.map((a) => [a, effectiveAngleWeight(mix.adjustments, a)] as const),
      rand(),
    );
    out.push(angle);
    last = angle?.id ?? last;
  }
  return out;
}

/** How a slot's angle is put to the writer (content_plan_items.angle; the prompt prints it). */
export function angleText(angle: {
  title: string;
  description: string;
  targetAudience: string;
}): string {
  return [
    angle.title,
    angle.description && `— ${angle.description}`,
    angle.targetAudience && `(for ${angle.targetAudience})`,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

/**
 * Lay out one period: slots from the cadence (free times only), a format per slot from the mix
 * (cheapest kept first when the allowance / cost cap / ceiling cannot cover every slot), an angle
 * per slot; then the background draft writes every post (draft-content-plan).
 */
export async function draftPeriod(
  deps: AutomationDeps & { rand?: () => number },
  automation: Automation,
  start: ReturnType<typeof localDateOf>,
  mix: MixPreferences,
): Promise<PeriodDraft> {
  const now = deps.now();
  const scope: Scope = {
    organisationId: automation.organisationId,
    businessId: automation.businessId,
  };
  const tier = toPlanTier(automation.planTier ?? undefined);
  const days = periodDays(automation.duration);
  const window = planWindow(start, days, automation.timezone);
  const held = await heldSlots(deps.db, scope, window.windowStart);
  const slots = availableSlots(
    candidateSlots(automation, start),
    held.map((h) => h.slotAt),
    now,
  );
  if (slots.length === 0) return { plan: null, reason: 'no_free_slots' };
  const formats = allocateFormats(
    slots.length,
    mix,
    await allowedFormats(deps.db, automation, mix, deps.env),
  );
  if (formats.length === 0) return { plan: null, reason: 'no_formats' };

  // The allowance and the cost cap, in allowance units, counted cheapest first.
  const { allowance, cost } = await loadPlanAllowance(deps, automation.organisationId, tier);
  const unitKinds: PlanKind[] = [...formats]
    .sort((a, b) => FORMATS[a].costRank - FORMATS[b].costRank)
    .flatMap((f) =>
      Array.from({ length: allowanceUnitsFor(f) }, () => FORMATS[f].planKind ?? 'VIDEO'),
    );
  const capped = capItems(unitKinds, tier, allowance, cost);
  const kept = new Set(
    keepCheapestFirst(formats, capped.count, {
      ceilingPence: automation.costCeilingPence,
      typicalPence: (f) => typicalItemCostPence(FORMATS[f].planKind ?? 'VIDEO', tier),
    }),
  );
  if (kept.size === 0) return { plan: null, reason: capped.cappedReason ?? 'cost_cap' };
  const angles = await listAngles(deps.db, scope);
  const slotAngles = pickAngles(slots.length, angles, mix, deps.rand ?? Math.random);
  const runId = randomUUID();
  const reason = kept.size < slots.length ? (capped.cappedReason ?? 'cost_cap') : null;
  const plan = await deps.db.contentPlan.create({
    data: {
      ...scope,
      createdByUserId: automation.createdByUserId,
      status: 'DRAFTING',
      startDate: formatLocalDate(start),
      days,
      timezone: automation.timezone,
      windowStart: new Date(window.windowStart),
      windowEnd: new Date(window.windowEnd),
      postsPerDay: Math.min(4, Math.max(1, Math.ceil(slots.length / days))),
      useDripSlots: false,
      videoShare: Math.round(
        (100 * formats.filter((f) => FORMATS[f].planKind === 'VIDEO').length) / formats.length,
      ),
      platforms: automation.platforms,
      targets: automation.targets as Prisma.InputJsonValue,
      language: automation.language,
      planTier: tier,
      requestedCount: slots.length,
      cappedReason: reason === 'allowance' || reason === 'cost_cap' ? reason : null,
      automationId: automation.id,
      metadata: {
        draftRunId: runId,
        automation: { id: automation.id, period: automation.periodIndex + 1 },
        ...(formats.some((f) => f === 'ugc') && { ugcActors: true }),
      },
      items: {
        create: slots.map((slotAt, position) => {
          const format = formats[position]!;
          const angle = slotAngles[position] ?? null;
          const keep = kept.has(position);
          return {
            organisationId: automation.organisationId,
            position,
            slotAt: new Date(slotAt),
            kind: FORMATS[format].planKind ?? 'VIDEO',
            format,
            angleId: angle?.id ?? null,
            angle: angle ? angleText(angle) : 'how_to',
            title: '',
            brief: '',
            ...(keep ? {} : { status: 'SKIPPED' as const, statusReason: 'cap_reached' }),
          };
        }),
      },
    },
  });
  await deps.queue.add(
    'draft-content-plan',
    { organisationId: plan.organisationId, planId: plan.id, runId, planTier: tier },
    {
      jobId: jobIds.draftContentPlan({
        organisationId: plan.organisationId,
        planId: plan.id,
        runId,
        planTier: tier,
      }),
    },
  );
  return { plan, reason };
}

// ------------------------------------------------------------------ start / pause / resume / cancel

export async function kickAutomation(queue: JobQueue, id: string, now: number): Promise<void> {
  await queue.add(
    'advance-automations',
    {
      organisationId: 'postmind-platform',
      runId: `automation-${id}`,
      planTier: 'STANDARD',
      automationId: id,
    },
    { jobId: jobIds.advanceAutomation(id, now) },
  );
}

async function firstStart(deps: AutomationDeps, automation: Automation) {
  const latest = await deps.db.contentPlan.findFirst({
    where: {
      organisationId: automation.organisationId,
      businessId: automation.businessId,
      status: { in: ['DRAFT', 'GENERATING', 'SCHEDULED'] },
    },
    orderBy: { windowEnd: 'desc' },
    select: { windowEnd: true },
  });
  return defaultStartDate(deps.now(), automation.timezone, latest?.windowEnd.getTime());
}

/** POST /automations/:id/start — snapshot the mix and draft the first period. */
export async function startAutomation(
  deps: AutomationDeps,
  tenant: TenantContext,
  id: string,
): Promise<{ automation: Automation; reason: PeriodDraft['reason'] }> {
  assertMayScheduleForOwner(tenant);
  const automation = await findAutomation(deps.db, tenant.organisationId, id);
  if (automation.status !== 'DRAFT')
    throw new ConflictError(`The automation is ${automation.status}`, {
      status: automation.status,
    });
  await assertChannels(deps.db, tenant.organisationId, automation.platforms, deps.now());
  const mix = await getMix(deps.db, {
    organisationId: automation.organisationId,
    businessId: automation.businessId,
  });
  const moved = await deps.db.automation.updateMany({
    where: { id, organisationId: tenant.organisationId, status: 'DRAFT' },
    data: {
      status: 'GENERATING',
      mixSnapshot: mix as unknown as Prisma.InputJsonValue,
      capabilities: tenant.capabilities,
      planTier: toPlanTier(tenant.organisation.planTier),
      activatedAt: new Date(deps.now()),
      pauseReason: null,
    },
  });
  if (moved.count === 0) throw new ConflictError('The automation changed; reload and try again');
  const fresh = await findAutomation(deps.db, tenant.organisationId, id);
  const draft = await draftPeriod(deps, fresh, await firstStart(deps, fresh), mix);
  if (!draft.plan) {
    await deps.db.automation.update({
      where: { id },
      data: { status: 'DRAFT', pauseReason: draft.reason },
    });
    throw new ValidationError(startRefusal(draft.reason), { code: draft.reason ?? 'not_started' });
  }
  const updated = await deps.db.automation.update({
    where: { id },
    data: { currentPlanId: draft.plan.id, periodIndex: 1 },
  });
  return { automation: updated, reason: draft.reason };
}

function startRefusal(reason: PeriodDraft['reason']): string {
  switch (reason) {
    case 'allowance':
      return 'Your plan has no videos left for now; add a channel or buy a video pack';
    case 'cost_cap':
      return 'This month’s limit leaves no room for more posts';
    case 'no_formats':
      return 'None of the chosen networks takes the formats in your content mix';
    case 'no_free_slots':
      return 'There are no free posting times in this period';
    default:
      return 'The automation could not start';
  }
}

async function setPlanPaused(db: PrismaClient, planId: string | null, paused: boolean) {
  if (!planId) return;
  const plan = await db.contentPlan.findUnique({
    where: { id: planId },
    select: { metadata: true },
  });
  if (!plan) return;
  const metadata = { ...((plan.metadata as Record<string, unknown> | null) ?? {}), paused };
  await db.contentPlan.update({
    where: { id: planId },
    data: { metadata: metadata as Prisma.InputJsonValue },
  });
}

/** POST /automations/:id/pause — no new generation starts and no next period is drafted. */
export async function pauseAutomation(
  deps: Pick<AutomationDeps, 'db' | 'now'>,
  organisationId: string,
  id: string,
  reason = 'owner',
): Promise<Automation> {
  const automation = await findAutomation(deps.db, organisationId, id);
  if (!['GENERATING', 'REVIEW', 'ACTIVE'].includes(automation.status))
    throw new ConflictError(`The automation is ${automation.status}`, {
      status: automation.status,
    });
  await setPlanPaused(deps.db, automation.currentPlanId, true);
  return deps.db.automation.update({
    where: { id },
    data: {
      status: 'PAUSED',
      pauseReason: reason,
      pausedAt: new Date(deps.now()),
      metadata: {
        ...((automation.metadata as Record<string, unknown> | null) ?? {}),
        pausedFrom: automation.status,
      } as Prisma.InputJsonValue,
    },
  });
}

/** POST /automations/:id/resume — back to where it was (the runner drafts a period if due). */
export async function resumeAutomation(
  deps: AutomationDeps,
  tenant: TenantContext,
  id: string,
): Promise<Automation> {
  assertMayScheduleForOwner(tenant);
  const automation = await findAutomation(deps.db, tenant.organisationId, id);
  if (automation.status !== 'PAUSED')
    throw new ConflictError(`The automation is ${automation.status}`, {
      status: automation.status,
    });
  const from = (automation.metadata as { pausedFrom?: string } | null)?.pausedFrom;
  const status = from === 'GENERATING' || from === 'REVIEW' ? from : 'ACTIVE';
  await setPlanPaused(deps.db, automation.currentPlanId, false);
  const updated = await deps.db.automation.update({
    where: { id },
    data: {
      status,
      pauseReason: null,
      pausedAt: null,
      capabilities: tenant.capabilities,
      planTier: toPlanTier(tenant.organisation.planTier),
    },
  });
  await kickAutomation(deps.queue, id, deps.now()).catch(() => undefined);
  return updated;
}

export function automationSummary(a: Automation) {
  const cadence = readCadence(a.cadence);
  return {
    id: a.id,
    businessId: a.businessId,
    name: a.name,
    status: a.status,
    cadence,
    duration: a.duration,
    ongoing: isOngoing(a.duration),
    platforms: a.platforms,
    targets: automationTargets(a).map((t) => ({
      platform: t.platform,
      connectionId: t.connectionId ?? null,
    })),
    approvalMode: a.approvalMode,
    timezone: a.timezone,
    language: a.language,
    periodIndex: a.periodIndex,
    currentPlanId: a.currentPlanId,
    pauseReason: a.pauseReason,
    activatedAt: a.activatedAt?.toISOString() ?? null,
    pausedAt: a.pausedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    cancelledAt: a.cancelledAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Posts the cadence makes in one period (before free times and the allowance). */
export function postsPerPeriod(cadence: Cadence, duration: string): number {
  const days = periodDays(duration);
  return cadence.mode === 'per_day'
    ? cadence.postsPerDay * days
    : (cadence.postsPerWeek * days) / 7;
}

export async function listAutomations(
  db: Pick<PrismaClient, 'automation'>,
  organisationId: string,
  query: z.infer<typeof listAutomationsQuery>,
) {
  const rows = await db.automation.findMany({
    where: { organisationId, ...(query.businessId && { businessId: query.businessId }) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(automationSummary);
}

/** The local date after a plan's last day (its windowEnd is local midnight). */
export function nextPeriodStart(plan: Pick<ContentPlan, 'windowEnd' | 'timezone'>) {
  return localDateOf(plan.windowEnd.getTime(), plan.timezone);
}

export const AUTOMATION_DAY_MS = DAY_MS;
export type { PlanTier };
