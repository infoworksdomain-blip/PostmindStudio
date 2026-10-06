import type { ContentPlan, ContentPlanItem, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { jsonOutput, runProvider, type ProviderRunDeps } from '../pipeline/provider-run';
import { projectMetadata } from '../pipeline/project-state';
import type { PlanTier } from '../providers/router';
import type { TextTask } from '../providers/text-tasks';
import { ProviderError } from '../../errors';
import {
  buildPlanPrompt,
  parsePlanResult,
  PLAN_BATCH_SIZE,
  PLAN_MAX_TOKENS,
  PLAN_PARALLEL_BATCHES,
  PLAN_OUTPUT_SCHEMA,
  planSystemPrompt,
  type PlanBusinessFacts,
  type PlannedTopic,
  type PromptSlot,
} from '../content-plans/prompt';
import type { PlanAngle, PlanKind } from '../content-plans/mix';
import { styleMemorySupplement } from './style-memory';
import { loadHashtagPolicy } from './business-hashtags';
import { buildSuggestions } from './caption-suggestions';
import { profileHashtags, type ProfileWords } from '../hashtags/pool';
import type { HashtagPolicy } from '../hashtags/policy';
import { PLATFORMS, type Platform } from './catalog';

// 20.9 — Claude writes the month (Layer-1 model via the provider router, like ideation): one call
// per PLAN_BATCH_SIZE slots (23.4: up to PLAN_PARALLEL_BATCHES at once), each told what the earlier
// batches already planned so the month does not repeat itself. Runs in the draft-content-plan job
// (a month is up to 124 posts, too long for a request) and, for one item, behind "Regenerate".

/** Passes over a month's unwritten posts in one draft job (the second retries failed batches). */
export const PLAN_DRAFT_ROUNDS = 2;

/** One structured Claude call; resolves the JSON and the model label. */
export type PlanGenerator = (request: {
  /** 23.2: month_plan and blitz_cards (standard), blitz_angles (light); text-tasks.ts. */
  task: TextTask;
  system: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  maxTokens: number;
}) => Promise<{ json: unknown; model: string }>;

/** The Claude call through the provider router (text_generation, costs recorded to the org). */
export function routedPlanGenerator(
  providers: ProviderRunDeps,
  scope: { organisationId: string; planTier: PlanTier },
): PlanGenerator {
  return async (request) => {
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'text_generation' },
        planTier: scope.planTier,
        request: {
          capability: 'text_generation',
          task: request.task,
          organisationId: scope.organisationId,
          system: request.system,
          prompt: request.prompt,
          outputSchema: request.outputSchema,
          maxTokens: request.maxTokens,
        },
      },
      providers,
    );
    const model = (run.output.metadata as { model?: string } | undefined)?.model;
    return {
      json: jsonOutput(run.output),
      model: `${run.decision.providerId}:${model ?? 'unknown'}`,
    };
  };
}

type DraftDb = Pick<
  PrismaClient,
  | 'business'
  | 'businessProfile'
  | 'brandKit'
  | 'videoProject'
  | 'styleMemory'
  | 'contentPlanItem'
  | 'businessHashtagSettings'
>;

export interface PlanContext {
  facts: PlanBusinessFacts;
  recentPosts: string[];
  styleMemory?: string;
  /** 20.13: the business + always hashtags every post carries, and profile top-up tags. */
  policy?: HashtagPolicy;
  profileTags?: string[];
}

const RECENT_DAYS = 90;
const RECENT_LIMIT = 40;

/** What Claude knows about the business: website scan, brand kit, style memory, recent posts. */
export async function loadPlanContext(
  db: DraftDb,
  plan: Pick<ContentPlan, 'id' | 'organisationId' | 'businessId' | 'brandKitId'>,
  now: number,
): Promise<PlanContext> {
  const scope = { organisationId: plan.organisationId, businessId: plan.businessId };
  const [business, profile, kit, recent, styleMemory, policy] = await Promise.all([
    db.business.findFirst({
      where: { id: plan.businessId, organisationId: plan.organisationId, deletedAt: null },
      select: { name: true },
    }),
    db.businessProfile.findUnique({ where: { organisationId_businessId: scope } }),
    db.brandKit.findFirst({
      where: plan.brandKitId
        ? { id: plan.brandKitId, organisationId: plan.organisationId }
        : { ...scope, isDefault: true },
    }),
    db.videoProject.findMany({
      where: {
        ...scope,
        deletedAt: null,
        createdAt: { gte: new Date(now - RECENT_DAYS * 86_400_000) },
      },
      select: { name: true, description: true, metadata: true },
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT * 2,
    }),
    styleMemorySupplement(db, plan.organisationId, plan.businessId),
    loadHashtagPolicy(db, scope),
  ]);
  const recentPosts = recent
    .filter(
      (p) =>
        (projectMetadata(p.metadata).contentPlan as { planId?: string } | undefined)?.planId !==
        plan.id,
    )
    .map((p) => p.name ?? p.description ?? '')
    .filter(Boolean)
    .slice(0, RECENT_LIMIT);
  return {
    facts: {
      businessName: business?.name ?? null,
      industry: profile?.industry,
      subNiche: profile?.subNiche,
      products: profile?.products,
      services: profile?.services,
      audienceKeywords: profile?.audienceKeywords,
      regions: profile?.regions,
      brandVoiceSummary: profile?.brandVoiceSummary,
      toneKeywords: kit?.toneKeywords,
      audienceProfile: kit?.audienceProfile,
      restrictedTopics: [
        ...new Set([...(kit?.restrictedTopics ?? []), ...(profile?.restrictedTopics ?? [])]),
      ],
    },
    recentPosts,
    ...(styleMemory && { styleMemory }),
    policy,
    profileTags: profileHashtags(profile as ProfileWords | null),
  };
}

/**
 * 20.13: one drafted caption + hashtags → the item's copy for each of the plan's platforms,
 * fitted to the platform and the business's hashtag policy (≥ 5, business hashtag first).
 */
export function itemPostCopy(
  platforms: readonly string[],
  topic: PlannedTopic,
  context: Pick<PlanContext, 'policy' | 'profileTags'>,
): Prisma.InputJsonValue {
  const list = platforms.filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  return buildSuggestions(
    list,
    list.map((platform) => ({ platform, ...topic.copy })),
    {
      policy: context.policy ?? { business: null, always: [] },
      pool: () => context.profileTags ?? [],
      fallbackCaption: topic.slides.hook,
    },
  ) as unknown as Prisma.InputJsonValue;
}

/** "Tuesday 6 October 2026" in the plan's time zone (English: the prompt is English). */
export function slotDateLabel(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(at);
}

type DraftItem = Pick<ContentPlanItem, 'id' | 'slotAt' | 'kind' | 'angle' | 'calendarDay'>;

export interface WriteTopicsOptions {
  /** Batches written at once (default PLAN_PARALLEL_BATCHES). */
  parallel?: number;
  /**
   * Passes over what is still unwritten (default 1). With more than one, a post whose title
   * repeats one already planned is left for the next pass (told every title so far); the last
   * pass keeps repeats (the automation's duplicate check or the owner deals with them).
   */
  rounds?: number;
  /** Only fill items that are still untitled (the background draft: idempotent on a retry). */
  onlyMissing?: boolean;
  logger?: Logger;
}

export interface WriteTopicsResult {
  /** The model label of the last successful call. */
  model: string | null;
  written: number;
  /** Items left unwritten (their batch failed, or repeats in every pass). */
  missing: DraftItem[];
  lastError: unknown;
}

/** "Why Sourdough Needs Patience!" → "why sourdough needs patience" (exact-repeat check). */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Write topics for `items` (slot order) in batches of PLAN_BATCH_SIZE, each call with the
 * planning output cap and its slots numbered from 1, up to `parallel` batches at once; each wave
 * is told every title written so far. 23.4 (production 2026-10-06: one 8 000-token answer for 20
 * posts was truncated): a batch that fails leaves only its own items unwritten; throws only when
 * nothing at all could be written.
 */
export async function writeTopics(
  deps: { db: Pick<PrismaClient, 'contentPlanItem' | '$transaction'>; generate: PlanGenerator },
  plan: Pick<ContentPlan, 'timezone' | 'language' | 'platforms'>,
  items: DraftItem[],
  context: PlanContext,
  plannedTitles: string[],
  options: WriteTopicsOptions = {},
): Promise<WriteTopicsResult> {
  const parallel = Math.max(1, options.parallel ?? PLAN_PARALLEL_BATCHES);
  const rounds = Math.max(1, options.rounds ?? 1);
  const planned = [...plannedTitles];
  const seen = new Set(plannedTitles.map(titleKey).filter(Boolean));
  const result: WriteTopicsResult = { model: null, written: 0, missing: [], lastError: null };
  let todo = [...items];
  for (let round = 1; round <= rounds && todo.length > 0; round += 1) {
    const rejectRepeats = round < rounds;
    const left: DraftItem[] = [];
    const batches = chunk(todo, PLAN_BATCH_SIZE);
    for (let w = 0; w < batches.length; w += parallel) {
      const wave = batches.slice(w, w + parallel);
      const titlesSoFar = [...planned];
      const answers = await Promise.allSettled(
        wave.map((batch) => topicsFor(deps.generate, plan, batch, context, titlesSoFar)),
      );
      for (const [b, answer] of answers.entries()) {
        const batch = wave[b] ?? [];
        if (answer.status === 'rejected') {
          result.lastError = answer.reason;
          options.logger?.warn(
            { err: answer.reason, posts: batch.length, round },
            'month plan batch could not be written',
          );
          left.push(...batch);
          continue;
        }
        result.model = answer.value.model;
        const keep: Array<{ item: DraftItem; topic: PlannedTopic }> = [];
        for (const [i, item] of batch.entries()) {
          const topic = answer.value.items[i] as PlannedTopic;
          const key = titleKey(topic.title);
          if (rejectRepeats && key && seen.has(key)) {
            left.push(item);
            continue;
          }
          seen.add(key);
          keep.push({ item, topic });
        }
        if (keep.length === 0) continue;
        await saveTopics(deps.db, plan, keep, context, options.onlyMissing ?? false);
        planned.push(...keep.map((k) => k.topic.title));
        result.written += keep.length;
      }
    }
    todo = left;
  }
  result.missing = todo;
  if (result.written === 0 && result.lastError) throw result.lastError;
  return result;
}

async function saveTopics(
  db: Pick<PrismaClient, 'contentPlanItem' | '$transaction'>,
  plan: Pick<ContentPlan, 'platforms'>,
  rows: Array<{ item: DraftItem; topic: PlannedTopic }>,
  context: PlanContext,
  onlyMissing: boolean,
): Promise<void> {
  await db.$transaction(
    rows.map(({ item, topic }) =>
      db.contentPlanItem.updateMany({
        // A retried (or overlapping) draft never overwrites a post that has been written since.
        where: onlyMissing ? { id: item.id, OR: [{ title: '' }, { brief: '' }] } : { id: item.id },
        data: {
          title: topic.title,
          brief: topic.brief,
          slides: topic.slides as unknown as Prisma.InputJsonValue,
          postCopy: itemPostCopy(plan.platforms, topic, context),
        },
      }),
    ),
  );
}

async function topicsFor(
  generate: PlanGenerator,
  plan: Pick<ContentPlan, 'timezone' | 'language'>,
  chunk: DraftItem[],
  context: PlanContext,
  plannedTitles: string[],
): Promise<{ items: PlannedTopic[]; model: string }> {
  const slots: PromptSlot[] = chunk.map((item, i) => ({
    index: i + 1,
    dateLabel: slotDateLabel(item.slotAt, plan.timezone),
    kind: item.kind as PlanKind,
    angle: item.angle as PlanAngle,
    calendarDay: item.calendarDay,
  }));
  const result = await generate({
    task: 'month_plan',
    system: planSystemPrompt(),
    prompt: buildPlanPrompt({
      facts: context.facts,
      slots,
      recentPosts: context.recentPosts,
      plannedTitles,
      styleMemory: context.styleMemory,
      language: plan.language,
      fixedHashtags: [
        ...(context.policy?.business ? [context.policy.business] : []),
        ...(context.policy?.always ?? []),
      ],
    }),
    outputSchema: PLAN_OUTPUT_SCHEMA,
    maxTokens: PLAN_MAX_TOKENS,
  });
  return { items: parsePlanResult(result.json, chunk.length), model: result.model };
}

/**
 * The draft-content-plan job: write every item that has no topic yet, then DRAFTING → DRAFT.
 * A stale run (the owner asked for a new draft) or a plan no longer drafting does nothing.
 */
export async function draftPlan(
  deps: {
    db: DraftDb & Pick<PrismaClient, 'contentPlan' | '$transaction'>;
    generate: PlanGenerator;
    logger: Logger;
    now: () => number;
  },
  planId: string,
  runId: string,
): Promise<void> {
  const plan = await deps.db.contentPlan.findUnique({ where: { id: planId } });
  if (!plan || plan.status !== 'DRAFTING') return;
  if ((plan.metadata as { draftRunId?: string } | null)?.draftRunId !== runId) return;
  const items = await deps.db.contentPlanItem.findMany({
    where: { planId, status: 'PLANNED' },
    orderBy: [{ slotAt: 'asc' }, { position: 'asc' }],
  });
  // 23.4: resumable — a retried job writes only what is still missing.
  const todo = items.filter((i) => !i.title || !i.brief);
  const done = items.filter((i) => i.title && i.brief).map((i) => i.title);
  const log = deps.logger.child({ planId, organisationId: plan.organisationId });
  const context = await loadPlanContext(deps.db, plan, deps.now());
  const written = await writeTopics(deps, plan, todo, context, done, {
    rounds: PLAN_DRAFT_ROUNDS,
    onlyMissing: true,
    logger: log,
  });
  if (written.missing.length > 0) {
    // Still DRAFTING: the job retries (only the missing posts); after its last attempt the plan
    // becomes a DRAFT that says so (draftPlanFailed), which an automation drafts again.
    const err = written.lastError;
    if (err && !(err instanceof ProviderError)) throw err;
    throw new ProviderError(
      'text_generation',
      'draft_incomplete',
      `Month plan draft incomplete: ${written.missing.length} of ${todo.length} posts unwritten`,
      true,
      { planId, missing: written.missing.length, written: written.written },
    );
  }
  await deps.db.contentPlan.updateMany({
    where: { id: planId, status: 'DRAFTING' },
    data: {
      status: 'DRAFT',
      draftError: null,
      ...(written.model && { draftModel: written.model }),
    },
  });
  log.info({ items: todo.length }, 'month plan drafted');
}

/** The job's last attempt failed: the plan becomes an editable DRAFT that says so. */
export async function draftPlanFailed(
  db: Pick<PrismaClient, 'contentPlan'>,
  planId: string,
  reason: string,
): Promise<void> {
  await db.contentPlan.updateMany({
    where: { id: planId, status: 'DRAFTING' },
    data: { status: 'DRAFT', draftError: reason.slice(0, 500) },
  });
}
