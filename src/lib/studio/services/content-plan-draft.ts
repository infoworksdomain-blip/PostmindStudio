import type { ContentPlan, ContentPlanItem, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { jsonOutput, runProvider, type ProviderRunDeps } from '../pipeline/provider-run';
import { projectMetadata } from '../pipeline/project-state';
import type { PlanTier } from '../providers/router';
import {
  buildPlanPrompt,
  parsePlanResult,
  PLAN_CHUNK_SIZE,
  PLAN_MAX_TOKENS,
  PLAN_OUTPUT_SCHEMA,
  planSystemPrompt,
  type PlanBusinessFacts,
  type PlannedTopic,
  type PromptSlot,
} from '../content-plans/prompt';
import type { PlanAngle, PlanKind } from '../content-plans/mix';
import { styleMemorySupplement } from './style-memory';

// 20.9 — Claude writes the month (Layer-1 model via the provider router, like ideation): one call
// per PLAN_CHUNK_SIZE slots, each told what the earlier chunks already planned so the month does
// not repeat itself. Runs in the draft-content-plan job (a month is up to 124 posts, too long for
// a request) and, for one item, behind "Regenerate" in the editor.

/** One structured Claude call; resolves the JSON and the model label. */
export type PlanGenerator = (request: {
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
  'business' | 'businessProfile' | 'brandKit' | 'videoProject' | 'styleMemory' | 'contentPlanItem'
>;

export interface PlanContext {
  facts: PlanBusinessFacts;
  recentPosts: string[];
  styleMemory?: string;
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
  const [business, profile, kit, recent, styleMemory] = await Promise.all([
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
  };
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

/** Write topics for `items` (slot order), chunk by chunk. Returns the model label used. */
export async function writeTopics(
  deps: { db: Pick<PrismaClient, 'contentPlanItem' | '$transaction'>; generate: PlanGenerator },
  plan: Pick<ContentPlan, 'timezone' | 'language'>,
  items: DraftItem[],
  context: PlanContext,
  plannedTitles: string[],
): Promise<string | null> {
  let model: string | null = null;
  const planned = [...plannedTitles];
  for (let start = 0; start < items.length; start += PLAN_CHUNK_SIZE) {
    const chunk = items.slice(start, start + PLAN_CHUNK_SIZE);
    const topics = await topicsFor(deps.generate, plan, chunk, context, planned);
    model = topics.model;
    await deps.db.$transaction(
      chunk.map((item, i) => {
        const topic = topics.items[i] as PlannedTopic;
        return deps.db.contentPlanItem.update({
          where: { id: item.id },
          data: {
            title: topic.title,
            brief: topic.brief,
            slides: topic.slides as unknown as Prisma.InputJsonValue,
          },
        });
      }),
    );
    planned.push(...topics.items.map((t) => t.title));
  }
  return model;
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
    system: planSystemPrompt(),
    prompt: buildPlanPrompt({
      facts: context.facts,
      slots,
      recentPosts: context.recentPosts,
      plannedTitles,
      styleMemory: context.styleMemory,
      language: plan.language,
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
  const todo = items.filter((i) => !i.title);
  const done = items.filter((i) => i.title).map((i) => i.title);
  const context = await loadPlanContext(deps.db, plan, deps.now());
  const model = await writeTopics(deps, plan, todo, context, done);
  await deps.db.contentPlan.updateMany({
    where: { id: planId, status: 'DRAFTING' },
    data: { status: 'DRAFT', draftError: null, ...(model && { draftModel: model }) },
  });
  deps.logger.info(
    { planId, organisationId: plan.organisationId, items: todo.length },
    'month plan drafted',
  );
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
