import type { BlitzSuggestion, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { TenantContext } from '../../tenant';
import { mergeMetadata } from '../automation/approval';
import { assertModeAllowed } from '../library/blueprint';
import {
  BLITZ_DAILY_RENDER_CAP,
  BLITZ_MONTHLY_RENDER_CAP_PENCE,
  BLITZ_QUEUE_SIZE,
  BLITZ_REFILL_DEBOUNCE_MS,
  BLITZ_SUGGESTION_TTL_DAYS,
} from '../blitz/constants';
import { DEDUPE_WINDOW_DAYS, fingerprintOf, isNearDuplicate } from '../blitz/fingerprint';
import { availableFormats, isFormatKey, isPremade, type FormatKey } from '../blitz/formats';
import {
  effectiveAngleWeight,
  effectiveMentionPercent,
  pickFormat,
  pickWeighted,
  type MixPreferences,
} from '../blitz/mix';
import { projectBodyForCard } from '../blitz/project-body';
import {
  BLITZ_CARDS_PER_CALL,
  BLITZ_MAX_TOKENS,
  BLITZ_OUTPUT_SCHEMA,
  blitzSystemPrompt,
  buildSuggestPrompt,
  hookTypeAt,
  parseSuggestResult,
  type CardRequest,
  type WrittenCard,
} from '../blitz/suggest-prompt';
import { renderPlatforms } from '../blitz/targets';
import type { KillSwitch } from '../kill-switch';
import { DEFAULT_LANGUAGE } from '../languages';
import { PLATFORM_RULES } from '../platforms/rules';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import { isUgcLanguage } from '../ugc/style';
import { canMakeHookDemoCard, hookDemoReadiness } from '../formats/availability';
import { listAngles, suggestAngles, type BusinessScope } from './angles';
import { PLATFORMS, type Platform } from './catalog';
import {
  itemPostCopy,
  loadPlanContext,
  type PlanContext,
  type PlanGenerator,
} from './content-plan-draft';
import { getMix } from './content-mix';
import { featureGateFor, type Feature } from './features';
import {
  BLITZ_SOURCE_REF_PREFIX,
  createProject,
  createProjectInput,
  generateProject,
} from './projects';

// 22.4 — keeping N ready Blitz cards per business (Fastlane: "about 5 suggestions are kept per
// workspace"). The refill-blitz-queue job (debounced per business, idempotent job id; the kill
// switch is checked at job start by the worker runtime):
//   1. retire cards nobody swiped for BLITZ_SUGGESTION_TTL_DAYS, and bring RENDERING cards in step
//      with their render projects (READY when the render is up for review, FAILED otherwise);
//   2. if fewer than BLITZ_QUEUE_SIZE are ready or rendering, choose each new card's format (the
//      business's mix), angle (weights), hook type (rotating), whether it names the business and
//      whether it remixes a reference-library video, and write all of them in ONE Claude call;
//   3. reject near-duplicates of the last 90 days (no_unique_content);
//   4. pre-made formats are RENDERED now (a project with sourceRef "blitz:<id>", generated as a
//      low-priority batch job; not counted against the allowance until kept); preview formats
//      (AI video, UGC) are stored as cards and never generated here.
// Pre-made renders stop at BLITZ_DAILY_RENDER_CAP a day and BLITZ_MONTHLY_RENDER_CAP_PENCE a month
// per business; the refill then only writes preview cards (if any paid format is switched on) or
// pauses until the caps reset (`paused` in the deck).

const DAY_MS = 86_400_000;

export interface RefillDeps {
  db: PrismaClient;
  queue: JobQueue;
  logger: Logger;
  now: () => number;
  killSwitch?: Pick<KillSwitch, 'check'>;
  generate: PlanGenerator;
  /** Random numbers in [0, 1) (injected for tests). */
  rand?: () => number;
  env?: Record<string, string | undefined>;
}

export interface RefillScope extends BusinessScope {
  userId: string;
  planTier: PlanTier;
}

export type RefillPause = 'kill_switch' | 'caps' | 'no_formats' | null;

export interface RefillResult {
  created: number;
  duplicates: number;
  failed: number;
  paused: RefillPause;
}

function utcDayStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcMonthStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Enqueue a refill (debounced: one job per business per BLITZ_REFILL_DEBOUNCE_MS). */
export async function requestRefill(
  queue: JobQueue,
  scope: RefillScope,
  now: number,
): Promise<void> {
  const window = Math.floor(now / BLITZ_REFILL_DEBOUNCE_MS);
  await queue.add(
    'refill-blitz-queue',
    {
      organisationId: scope.organisationId,
      businessId: scope.businessId,
      userId: scope.userId,
      runId: `blitz-${window}`,
      planTier: scope.planTier,
      batch: true,
    },
    { jobId: jobIds.refillBlitz(scope.businessId, window) },
  );
}

// ------------------------------------------------------------------ caps

export interface BlitzCaps {
  rendersToday: number;
  rendersLeftToday: number;
  monthSpendPence: number;
  premadeAllowed: boolean;
}

export async function blitzCaps(
  db: Pick<PrismaClient, 'blitzSuggestion' | 'videoProject'>,
  scope: BusinessScope,
  now: number,
): Promise<BlitzCaps> {
  const premade = availableFormats().filter(isPremade);
  const [rendersToday, monthRenders] = await Promise.all([
    db.blitzSuggestion.count({
      where: {
        ...scope,
        format: { in: premade },
        projectId: { not: null },
        createdAt: { gte: utcDayStart(now) },
      },
    }),
    db.blitzSuggestion.findMany({
      where: {
        ...scope,
        format: { in: premade },
        projectId: { not: null },
        createdAt: { gte: utcMonthStart(now) },
      },
      select: { projectId: true },
    }),
  ]);
  const ids = monthRenders.flatMap((r) => (r.projectId ? [r.projectId] : []));
  const spend = ids.length
    ? await db.videoProject.aggregate({
        where: { id: { in: ids }, organisationId: scope.organisationId },
        _sum: { costActualPence: true },
      })
    : { _sum: { costActualPence: 0 } };
  const monthSpendPence = spend._sum.costActualPence ?? 0;
  return {
    rendersToday,
    rendersLeftToday: Math.max(0, BLITZ_DAILY_RENDER_CAP - rendersToday),
    monthSpendPence,
    premadeAllowed:
      rendersToday < BLITZ_DAILY_RENDER_CAP && monthSpendPence < BLITZ_MONTHLY_RENDER_CAP_PENCE,
  };
}

// ------------------------------------------------------------------ keeping cards in step

const FAILED_STATES = new Set(['FAILED', 'QUALITY_FAILED', 'REJECTED', 'ARCHIVED']);

async function archiveRender(
  db: PrismaClient,
  organisationId: string,
  projectId: string,
  now: number,
) {
  await db.videoProject.updateMany({
    where: { id: projectId, organisationId, sourceRef: { startsWith: BLITZ_SOURCE_REF_PREFIX } },
    data: { state: 'ARCHIVED', deletedAt: new Date(now) },
  });
}

/** RENDERING → READY / FAILED by the render project; old unswiped cards → EXPIRED. */
export async function syncSuggestions(
  db: PrismaClient,
  scope: BusinessScope,
  now: number,
): Promise<void> {
  const stale = await db.blitzSuggestion.findMany({
    where: {
      ...scope,
      status: { in: ['RENDERING', 'READY'] },
      createdAt: { lt: new Date(now - BLITZ_SUGGESTION_TTL_DAYS * DAY_MS) },
    },
    select: { id: true, projectId: true },
  });
  for (const s of stale) {
    await db.blitzSuggestion.updateMany({
      where: { id: s.id, status: { in: ['RENDERING', 'READY'] } },
      data: { status: 'EXPIRED' },
    });
    if (s.projectId) await archiveRender(db, scope.organisationId, s.projectId, now);
  }
  const rendering = await db.blitzSuggestion.findMany({
    where: { ...scope, status: 'RENDERING', projectId: { not: null } },
    select: { id: true, projectId: true },
  });
  if (rendering.length === 0) return;
  const projects = await db.videoProject.findMany({
    where: { id: { in: rendering.map((r) => r.projectId!) }, organisationId: scope.organisationId },
    select: { id: true, state: true, errorReason: true },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  for (const s of rendering) {
    const p = byId.get(s.projectId!);
    if (!p || FAILED_STATES.has(p.state) || p.state === 'DRAFT') {
      // DRAFT = the pipeline parked it (vague brief / restricted topic): not a card to show.
      await db.blitzSuggestion.updateMany({
        where: { id: s.id, status: 'RENDERING' },
        data: {
          status: 'FAILED',
          failureReason: (p?.errorReason ?? 'render_failed').slice(0, 200),
        },
      });
      if (p) await archiveRender(db, scope.organisationId, p.id, now);
    } else if (p.state === 'READY_FOR_REVIEW') {
      await db.blitzSuggestion.updateMany({
        where: { id: s.id, status: 'RENDERING' },
        data: { status: 'READY' },
      });
    }
  }
}

// ------------------------------------------------------------------ choosing the cards

interface Planned extends CardRequest {
  angleId: string | null;
  remixLibraryItemId: string | null;
}

async function remixCandidates(db: PrismaClient, now: number) {
  const items = await db.videoLibraryItem.findMany({
    where: { retiredAt: null, analysis: { isNot: null } },
    include: { analysis: true, license: true },
    orderBy: { ingestedAt: 'desc' },
    take: 50,
  });
  return items.filter((item) => {
    try {
      // Structure only (INSPIRE): never the footage, never the words.
      assertModeAllowed('INSPIRE', item.license, now);
      return item.analysis !== null;
    } catch {
      return false;
    }
  });
}

async function enabledFormats(
  db: PrismaClient,
  scope: { organisationId: string; businessId: string },
  language: string,
  now: Date,
) {
  const gate = featureGateFor(db);
  const feature: Partial<Record<FormatKey, Feature>> = {
    carousel: 'carousels',
    slideshow: 'slideshow',
  };
  const out: FormatKey[] = [];
  for (const key of availableFormats()) {
    const f = feature[key];
    if (f && !(await gate.status(f, scope.organisationId)).enabled) continue;
    if (key === 'ugc' && !isUgcLanguage(language)) continue;
    // 22.1: a pre-made hook + demo card needs a demo video and a licensed library hook clip
    // (never a paid generated clip for a card nobody kept).
    if (key === 'hook_demo' && !canMakeHookDemoCard(await hookDemoReadiness(db, { ...scope, now })))
      continue;
    out.push(key);
  }
  return out;
}

export function planCards(input: {
  count: number;
  mix: MixPreferences;
  formats: readonly FormatKey[];
  angles: ReadonlyArray<{
    id: string;
    title: string;
    description: string;
    targetAudience: string;
    weight: number;
  }>;
  remix: ReadonlyArray<{ id: string; title: string; notes: string }>;
  premadeLeft: number;
  hookSeed: number;
  rand: () => number;
}): Planned[] {
  const out: Planned[] = [];
  let premadeLeft = input.premadeLeft;
  for (let i = 0; i < input.count; i += 1) {
    const formats = input.formats.filter((f) => !isPremade(f) || premadeLeft > 0);
    const format = pickFormat(input.mix, formats, input.rand());
    if (!format) break;
    if (isPremade(format)) premadeLeft -= 1;
    const angle = pickWeighted(
      input.angles.map((a) => [a, effectiveAngleWeight(input.mix.adjustments, a)] as const),
      input.rand(),
    );
    const remix =
      isPremade(format) && input.remix.length > 0 && input.rand() * 100 < input.mix.remixPercent
        ? input.remix[Math.floor(input.rand() * input.remix.length)]!
        : null;
    out.push({
      index: i + 1,
      format,
      angle: angle
        ? {
            title: angle.title,
            description: angle.description,
            targetAudience: angle.targetAudience,
          }
        : null,
      angleId: angle?.id ?? null,
      hookType: hookTypeAt(input.hookSeed + i),
      mentionBusiness: input.rand() * 100 < effectiveMentionPercent(input.mix),
      remix: remix ? { title: remix.title, notes: remix.notes } : null,
      remixLibraryItemId: remix?.id ?? null,
    });
  }
  return out;
}

/** Fingerprints of the business's last 90 days: cards, month-plan posts and project names. */
export async function recentFingerprints(
  db: PrismaClient,
  scope: BusinessScope,
  now: number,
): Promise<string[]> {
  const since = new Date(now - DEDUPE_WINDOW_DAYS * DAY_MS);
  const [cards, items, projects] = await Promise.all([
    db.blitzSuggestion.findMany({
      where: { ...scope, createdAt: { gte: since }, status: { not: 'FAILED' } },
      select: { fingerprint: true },
      take: 1_000,
    }),
    db.contentPlanItem.findMany({
      where: {
        organisationId: scope.organisationId,
        plan: { businessId: scope.businessId },
        createdAt: { gte: since },
        status: { notIn: ['REMOVED', 'SKIPPED'] },
      },
      select: { fingerprint: true, title: true, slides: true },
      take: 1_000,
    }),
    db.videoProject.findMany({
      where: { ...scope, createdAt: { gte: since }, deletedAt: null },
      select: { name: true },
      take: 1_000,
    }),
  ]);
  return [
    ...cards.map((c) => c.fingerprint),
    ...items.map(
      (i) =>
        i.fingerprint ??
        fingerprintOf(i.title, (i.slides as { hook?: string } | null)?.hook ?? null),
    ),
    ...projects.map((p) => fingerprintOf(p.name)),
  ].filter(Boolean);
}

async function businessLanguage(db: PrismaClient, scope: BusinessScope): Promise<string> {
  const latest = await db.videoProject.findFirst({
    where: { ...scope, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { language: true },
  });
  return latest?.language ?? DEFAULT_LANGUAGE;
}

async function connectedPlatforms(db: PrismaClient, scope: BusinessScope): Promise<Platform[]> {
  const rows = await db.platformConnection.findMany({
    where: {
      organisationId: scope.organisationId,
      state: 'active',
      OR: [{ businessId: scope.businessId }, { businessId: null }],
    },
    select: { platform: true },
  });
  const networks = new Set(rows.map((r) => r.platform));
  return PLATFORMS.filter((p) => networks.has(PLATFORM_RULES[p].connectionPlatform));
}

async function previewImageFor(db: PrismaClient, scope: BusinessScope): Promise<string | null> {
  const image = await db.imageLibraryItem.findFirst({
    where: { ...scope, s3Key: { not: '' } },
    orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  return image?.id ?? null;
}

// ------------------------------------------------------------------ the job

/** The refill-blitz-queue job body. */
export async function refillBlitzQueue(
  deps: RefillDeps,
  scope: RefillScope,
): Promise<RefillResult> {
  const now = deps.now();
  const rand = deps.rand ?? Math.random;
  const business = { organisationId: scope.organisationId, businessId: scope.businessId };
  const log = deps.logger.child({ ...business, job: 'refill-blitz-queue' });
  const result: RefillResult = { created: 0, duplicates: 0, failed: 0, paused: null };
  if (
    deps.killSwitch &&
    (await deps.killSwitch.check({ organisationId: scope.organisationId })).killed
  )
    return { ...result, paused: 'kill_switch' };
  await syncSuggestions(deps.db, business, now);
  const pending = await deps.db.blitzSuggestion.count({
    where: { ...business, status: { in: ['RENDERING', 'READY'] } },
  });
  const need = BLITZ_QUEUE_SIZE - pending;
  if (need <= 0) return result;

  const [caps, mix, language] = await Promise.all([
    blitzCaps(deps.db, business, now),
    getMix(deps.db, business),
    businessLanguage(deps.db, business),
  ]);
  const formats = (await enabledFormats(deps.db, scope, language, new Date(now))).filter(
    (f) => caps.premadeAllowed || !isPremade(f),
  );
  const live = formats.filter((f) => (mix.formatWeights[f] ?? 0) > 0);
  if (live.length === 0) {
    const paused: RefillPause = caps.premadeAllowed ? 'no_formats' : 'caps';
    log.info({ paused, caps }, 'blitz refill paused');
    return { ...result, paused };
  }

  let angles = await listAngles(deps.db, business);
  if (angles.length === 0) {
    try {
      angles = await suggestAngles(
        { db: deps.db, generate: deps.generate, now: deps.now },
        business,
        scope.userId,
        5,
      );
    } catch (err) {
      // Cards without an angle still work ("any angle that fits the business").
      log.warn({ err }, 'blitz could not suggest starter angles');
    }
  }
  const remix = mix.remixPercent > 0 ? await remixCandidates(deps.db, now) : [];
  const total = await deps.db.blitzSuggestion.count({ where: business });
  const planned = planCards({
    count: need,
    mix,
    formats: live,
    angles,
    remix: remix.map((item) => ({
      id: item.id,
      title: item.title,
      notes: `${item.analysis!.hookPattern}; ${item.analysis!.structurePattern}; ${item.analysis!.paceTag} pace`,
    })),
    premadeLeft: caps.premadeAllowed ? caps.rendersLeftToday : 0,
    hookSeed: total,
    rand,
  });
  if (planned.length === 0) return { ...result, paused: 'no_formats' };

  const context = await loadPlanContext(
    deps.db,
    {
      id: '',
      organisationId: scope.organisationId,
      businessId: scope.businessId,
      brandKitId: null,
    },
    now,
  );
  const written = await writeCards(deps, planned, context, language, log);
  const seen = await recentFingerprints(deps.db, business, now);
  const platforms = await connectedPlatforms(deps.db, business);
  const previewImageId = planned.some((p) => !isPremade(p.format))
    ? await previewImageFor(deps.db, business)
    : null;
  for (const [i, plan] of planned.entries()) {
    const card = written[i];
    if (!card) {
      result.failed += 1;
      continue;
    }
    const fingerprint = fingerprintOf(card.title, card.hook);
    const duplicate = isNearDuplicate(fingerprint, seen);
    seen.push(fingerprint);
    if (duplicate) {
      result.duplicates += 1;
      await deps.db.blitzSuggestion.create({
        data: {
          ...business,
          format: plan.format,
          status: 'FAILED',
          failureReason: 'no_unique_content',
          copy: cardCopy(card, plan, {}) as Prisma.InputJsonValue,
          whyItWorks: card.whyItWorks,
          fingerprint,
          angleId: plan.angleId,
        },
      });
      continue;
    }
    const created = await createCard(deps, scope, {
      plan,
      card,
      fingerprint,
      language,
      platforms,
      context,
      previewImageId,
      log,
    });
    if (created) result.created += 1;
    else result.failed += 1;
  }
  log.info({ ...result, need }, 'blitz queue refilled');
  return result;
}

/**
 * Production 2026-10-06 ("anthropic/output_truncated: Output hit max_tokens (8000)"): five cards of
 * up to eight 220-character posts each, with picture queries, captions and hashtags, do not fit one
 * answer. Cards are written BLITZ_CARDS_PER_CALL at a time, each call with the planning cap; a batch
 * that fails leaves only its own cards unwritten (counted as failed), unless every batch fails.
 */
async function writeCards(
  deps: RefillDeps,
  planned: Planned[],
  context: Awaited<ReturnType<typeof loadPlanContext>>,
  language: string,
  log: Logger,
): Promise<Array<WrittenCard | null>> {
  // Each batch is numbered from 1 (the prompt lists `index.` and the answer is matched on it).
  const batches = chunk(planned, BLITZ_CARDS_PER_CALL).map((batch) =>
    batch.map((card, i) => ({ ...card, index: i + 1 })),
  );
  const out: Array<WrittenCard | null> = [];
  let lastError: unknown = null;
  let succeeded = 0;
  for (const batch of batches) {
    try {
      const answer = await deps.generate({
        task: 'blitz_cards',
        system: blitzSystemPrompt(),
        prompt: buildSuggestPrompt({
          facts: context.facts,
          cards: batch,
          recentPosts: context.recentPosts,
          language,
          styleMemory: context.styleMemory,
          fixedHashtags: [
            ...(context.policy?.business ? [context.policy.business] : []),
            ...(context.policy?.always ?? []),
          ],
        }),
        outputSchema: BLITZ_OUTPUT_SCHEMA,
        maxTokens: BLITZ_MAX_TOKENS,
      });
      out.push(...parseSuggestResult(answer.json, batch.length));
      succeeded += 1;
    } catch (err) {
      lastError = err;
      log.warn({ err, cards: batch.length }, 'blitz batch could not be written');
      out.push(...batch.map(() => null));
    }
  }
  if (succeeded === 0 && lastError) throw lastError;
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function cardCopy(
  card: WrittenCard,
  plan: Planned,
  captions: Prisma.InputJsonValue | Record<string, never>,
) {
  return {
    title: card.title,
    hook: card.hook,
    body: card.body,
    cta: card.cta,
    imageQueries: card.imageQueries,
    hookType: plan.hookType,
    captions,
  };
}

/** The tenant a refill acts as: the person whose Blitz asked for it (projects need a creator). */
function refillTenant(scope: RefillScope): TenantContext {
  return {
    userId: scope.userId,
    organisationId: scope.organisationId,
    organisation: { id: scope.organisationId, planTier: scope.planTier },
    memberships: [],
    capabilities: [],
  };
}

async function createCard(
  deps: RefillDeps,
  scope: RefillScope,
  input: {
    plan: Planned;
    card: WrittenCard;
    fingerprint: string;
    language: string;
    platforms: Platform[];
    context: PlanContext;
    previewImageId: string | null;
    log: Logger;
  },
): Promise<BlitzSuggestion | null> {
  const { plan, card } = input;
  const business = { organisationId: scope.organisationId, businessId: scope.businessId };
  const destinations = renderPlatforms(plan.format, input.platforms);
  const captions = itemPostCopy(
    destinations,
    {
      title: card.title,
      brief: card.hook,
      slides: { hook: card.hook, points: card.body, cta: card.cta },
      copy: { caption: card.caption, hashtags: card.hashtags },
    },
    input.context,
  );
  const premade = isPremade(plan.format);
  const suggestion = await deps.db.blitzSuggestion.create({
    data: {
      ...business,
      angleId: plan.angleId,
      format: plan.format,
      status: premade ? 'RENDERING' : 'READY',
      copy: cardCopy(card, plan, captions) as Prisma.InputJsonValue,
      whyItWorks: card.whyItWorks,
      mentionBusiness: plan.mentionBusiness,
      remixLibraryItemId: plan.remixLibraryItemId,
      remixMode: plan.remixLibraryItemId ? 'INSPIRE' : null,
      previewImageId: premade ? null : input.previewImageId,
      fingerprint: input.fingerprint,
    },
  });
  if (!premade) return suggestion;
  try {
    const tenant = refillTenant(scope);
    const body = createProjectInput.parse({
      ...projectBodyForCard(plan.format, card, {
        businessId: scope.businessId,
        language: input.language,
        platforms: destinations,
        sourceRef: `${BLITZ_SOURCE_REF_PREFIX}${suggestion.id}`,
      }),
      reviewPolicy: 'REQUIRE_APPROVAL',
      publishPolicy: 'MANUAL',
    });
    const project = await createProject(deps.db, tenant, body, deps.now());
    await mergeMetadata(deps.db, project.id, {
      blitz: { suggestionId: suggestion.id, state: 'pending' },
      postCopy: captions,
    });
    await deps.db.blitzSuggestion.update({
      where: { id: suggestion.id },
      data: { projectId: project.id },
    });
    await generateProject(deps, tenant, project.id, {}, { batch: true });
    return suggestion;
  } catch (err) {
    input.log.warn({ err, suggestionId: suggestion.id }, 'blitz render did not start');
    await deps.db.blitzSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'FAILED', failureReason: 'render_not_started' },
    });
    return null;
  }
}

export function isBlitzFormat(value: string): value is FormatKey {
  return isFormatKey(value);
}
