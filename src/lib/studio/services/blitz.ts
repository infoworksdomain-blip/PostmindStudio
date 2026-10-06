import type { BlitzSuggestion, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditEntry } from '../../audit';
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError } from '../../errors';
import { hasCapability, StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import { mergeMetadata } from '../automation/approval';
import { publishOnApproval } from '../automation/auto-publish';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { BLITZ_DAILY_SWIPES, BLITZ_QUEUE_SIZE } from '../blitz/constants';
import { FORMATS, isFormatKey, isPremade, type FormatKey } from '../blitz/formats';
import { SKIP_REASONS, type NudgeNotice } from '../blitz/mix';
import { projectBodyForCard, type CardCopy } from '../blitz/project-body';
import { nextFreeSlot } from '../blitz/schedule';
import { accountTargets } from '../blitz/targets';
import { signThumbnail } from '../library/thumbnail-signing';
import { toPlanTier } from './catalog';
import { approveWithWorkflow } from './approval-workflows';
import { latestRender } from './carousels';
import { recordSignal } from './content-mix';
import { blitzCaps, requestRefill, syncSuggestions, type BlitzCaps } from './blitz-refill';
import { checkGenerateQuota, notifyQuotaThresholds, releaseQuotaReservation } from './plan-quotas';
import { createProject, createProjectInput, findProject, generateProject } from './projects';
import type { BusinessScope } from './angles';
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';

// 22.4 — the Blitz deck and the swipe. GET returns the ready cards (pre-made ones with their
// rendered slides / video; preview ones with a still from the business's library) and tops the
// deck up in the background. A swipe:
//   skip  → the card goes (its render project is archived), an optional reason nudges the mix
//           ("You'll see fewer carousels"), the deck refills;
//   keep  → the allowance is reserved exactly as Create's generate does (a pre-made card counts
//           when kept, never when shown; a paid card is generated only now), then
//           schedule (next free slot, default) | post_now | edit (open the project).
// Plan rules: the channel limit (only allowed networks become targets), the allowance (403
// quota_exceeded → the upgrade / pack dialog), read-only organisations (402 at the route).

const URL_TTL_SEC = 60 * 60;
const DAY_MS = 86_400_000;

export const KEEP_MODES = ['schedule', 'post_now', 'edit'] as const;
export type KeepMode = (typeof KEEP_MODES)[number];

export const decisionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep'), mode: z.enum(KEEP_MODES).default('schedule') }).strict(),
  z.object({ action: z.literal('skip'), reason: z.enum(SKIP_REASONS).optional() }).strict(),
]);

export const deckQuery = z.object({ businessId: z.string().trim().min(1).max(128) });
export const refillInput = z.object({ businessId: z.string().trim().min(1).max(128) }).strict();

export interface BlitzDeps {
  db: PrismaClient;
  queue: JobQueue;
  storage: AssetStorage;
  logger: Logger;
  now: () => number;
  audit: (entry: AuditEntry) => void;
  env?: Record<string, string | undefined>;
  entitlements?: EntitlementsReader;
}

interface StoredCopy extends CardCopy {
  hookType?: string;
  captions?: Record<string, { caption?: string; hashtags?: string[] }>;
}

function copyOf(s: Pick<BlitzSuggestion, 'copy'>): StoredCopy {
  const c = (s.copy ?? {}) as Partial<StoredCopy>;
  return {
    title: typeof c.title === 'string' ? c.title : '',
    hook: typeof c.hook === 'string' ? c.hook : '',
    body: Array.isArray(c.body) ? c.body.filter((b): b is string => typeof b === 'string') : [],
    cta: typeof c.cta === 'string' ? c.cta : '',
    imageQueries: Array.isArray(c.imageQueries) ? c.imageQueries : [],
    ...(typeof c.hookType === 'string' && { hookType: c.hookType }),
    ...(c.captions && typeof c.captions === 'object' && { captions: c.captions }),
  };
}

function utcDayStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ------------------------------------------------------------------ the deck

export interface CardView {
  id: string;
  format: FormatKey;
  tier: 'premade' | 'preview';
  angle: { id: string; title: string } | null;
  title: string;
  hook: string;
  body: string[];
  cta: string;
  hookType: string | null;
  caption: string | null;
  whyItWorks: string;
  mentionBusiness: boolean;
  /** Carousel slide images (signed, 1 h). */
  slides: string[];
  /** Slideshow / video render (signed, 1 h) and its poster. */
  videoUrl: string | null;
  posterUrl: string | null;
  /** Preview cards: a still from the business's library. */
  previewImageUrl: string | null;
  remix: { id: string; title: string; thumbnailUrl: string | null; durationSec: number } | null;
  /** Videos of the allowance a keep uses (1, or 2 for a UGC video). */
  allowanceUnits: number;
  createdAt: string;
}

async function signed(storage: AssetStorage, bucket: string, key: string | null | undefined) {
  if (!key) return null;
  return storage.signedUrl(bucket, key, URL_TTL_SEC);
}

async function cardView(
  deps: Pick<BlitzDeps, 'db' | 'storage' | 'now'>,
  s: BlitzSuggestion,
  angles: Map<string, string>,
): Promise<CardView | null> {
  if (!isFormatKey(s.format)) return null;
  const copy = copyOf(s);
  let slides: string[] = [];
  let videoUrl: string | null = null;
  let posterUrl: string | null = null;
  if (s.projectId) {
    const project = await deps.db.videoProject.findFirst({
      where: { id: s.projectId, organisationId: s.organisationId },
      select: { id: true, metadata: true },
    });
    if (project && s.format === 'carousel') {
      const render = await latestRender(deps.db, deps.storage, project);
      slides = render?.slides.map((slide) => slide.pngUrl) ?? [];
    } else if (project) {
      const render = await deps.db.videoRender.findFirst({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      });
      if (render) {
        videoUrl = await signed(deps.storage, render.s3Bucket, render.s3Key);
        posterUrl = await signed(deps.storage, render.s3Bucket, render.thumbnailS3Key);
      }
    }
  }
  let previewImageUrl: string | null = null;
  if (s.previewImageId) {
    const image = await deps.db.imageLibraryItem.findFirst({
      where: { id: s.previewImageId, organisationId: s.organisationId },
      select: { s3Bucket: true, s3Key: true },
    });
    if (image) previewImageUrl = await signed(deps.storage, image.s3Bucket, image.s3Key);
  }
  let remix: CardView['remix'] = null;
  if (s.remixLibraryItemId) {
    const item = await deps.db.videoLibraryItem.findFirst({
      where: { id: s.remixLibraryItemId, retiredAt: null },
      select: { id: true, title: true, s3Bucket: true, thumbnailS3Key: true, durationSec: true },
    });
    if (item)
      remix = {
        id: item.id,
        title: item.title,
        thumbnailUrl: item.thumbnailS3Key
          ? await signThumbnail(deps.storage, item.s3Bucket, item.thumbnailS3Key, deps.now())
          : null,
        durationSec: item.durationSec,
      };
  }
  const caption = Object.values(copy.captions ?? {})[0]?.caption ?? null;
  return {
    id: s.id,
    format: s.format,
    tier: FORMATS[s.format].tier,
    angle:
      s.angleId && angles.has(s.angleId) ? { id: s.angleId, title: angles.get(s.angleId)! } : null,
    title: copy.title,
    hook: copy.hook,
    body: copy.body,
    cta: copy.cta,
    hookType: copy.hookType ?? null,
    caption,
    whyItWorks: s.whyItWorks,
    mentionBusiness: s.mentionBusiness,
    slides,
    videoUrl,
    posterUrl,
    previewImageUrl,
    remix,
    allowanceUnits: s.format === 'ugc' ? 2 : 1,
    createdAt: s.createdAt.toISOString(),
  };
}

export interface DeckView {
  cards: CardView[];
  rendering: number;
  swipesToday: number;
  swipesLeft: number;
  caps: BlitzCaps;
  /** Why no new cards are coming (null = more are on the way when the deck runs low). */
  paused: 'caps' | 'swipe_cap' | null;
}

export async function getDeck(
  deps: BlitzDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'userId' | 'organisation' | 'access'>,
  businessId: string,
): Promise<DeckView> {
  const scope = { organisationId: tenant.organisationId, businessId };
  const now = deps.now();
  await syncSuggestions(deps.db, scope, now);
  const [ready, rendering, swipesToday, caps, angles] = await Promise.all([
    deps.db.blitzSuggestion.findMany({
      where: { ...scope, status: 'READY' },
      orderBy: { createdAt: 'asc' },
      take: BLITZ_QUEUE_SIZE * 2,
    }),
    deps.db.blitzSuggestion.count({ where: { ...scope, status: 'RENDERING' } }),
    swipeCount(deps.db, tenant, now),
    blitzCaps(deps.db, scope, now),
    deps.db.contentAngle.findMany({ where: scope, select: { id: true, title: true } }),
  ]);
  const titles = new Map(angles.map((a) => [a.id, a.title]));
  const cards = (await Promise.all(ready.map((s) => cardView(deps, s, titles)))).filter(
    (c): c is CardView => c !== null,
  );
  const swipesLeft = Math.max(0, BLITZ_DAILY_SWIPES - swipesToday);
  // Read-only / no-plan organisations see what is there; nothing new is made for them.
  const mayMake = !tenant.access || tenant.access === 'full';
  if (mayMake && cards.length + rendering < BLITZ_QUEUE_SIZE && swipesLeft > 0)
    await requestRefill(
      deps.queue,
      { ...scope, userId: tenant.userId, planTier: toPlanTier(tenant.organisation.planTier) },
      now,
    ).catch((err: unknown) => deps.logger.warn({ err, businessId }, 'blitz refill not queued'));
  return {
    cards,
    rendering,
    swipesToday,
    swipesLeft,
    caps,
    paused: swipesLeft === 0 ? 'swipe_cap' : caps.premadeAllowed ? null : 'caps',
  };
}

function swipeCount(
  db: Pick<PrismaClient, 'blitzSuggestion'>,
  tenant: Pick<TenantContext, 'organisationId' | 'userId'>,
  now: number,
) {
  return db.blitzSuggestion.count({
    where: {
      organisationId: tenant.organisationId,
      decidedByUserId: tenant.userId,
      decidedAt: { gte: utcDayStart(now) },
    },
  });
}

/** POST /blitz/refill — "Generate more" (still within the caps; debounced). */
export async function refillNow(
  deps: Pick<BlitzDeps, 'queue' | 'now'>,
  tenant: Pick<TenantContext, 'organisationId' | 'userId' | 'organisation'>,
  businessId: string,
): Promise<void> {
  await requestRefill(
    deps.queue,
    {
      organisationId: tenant.organisationId,
      businessId,
      userId: tenant.userId,
      planTier: toPlanTier(tenant.organisation.planTier),
    },
    deps.now(),
  );
}

// ------------------------------------------------------------------ the swipe

export interface DecisionResult {
  suggestionId: string;
  action: 'keep' | 'skip';
  projectId: string | null;
  /** What happened to posting: scheduled / posting / waiting for approval / editing / no account. */
  publish: 'scheduled' | 'posting' | 'awaiting_approval' | 'edit' | 'no_accounts' | null;
  scheduledFor: string | null;
  downloadOnly: string[];
  notice: NudgeNotice | null;
}

async function claim(
  db: Pick<PrismaClient, 'blitzSuggestion'>,
  s: BlitzSuggestion,
  status: 'KEPT' | 'SKIPPED',
  userId: string,
  now: number,
  skipReason?: string,
) {
  const moved = await db.blitzSuggestion.updateMany({
    where: { id: s.id, organisationId: s.organisationId, status: 'READY' },
    data: {
      status,
      decidedAt: new Date(now),
      decidedByUserId: userId,
      ...(skipReason && { skipReason }),
    },
  });
  if (moved.count === 0)
    throw new ConflictError('This card was already swiped', { code: 'swiped' });
}

async function unclaim(db: Pick<PrismaClient, 'blitzSuggestion'>, s: BlitzSuggestion) {
  await db.blitzSuggestion.updateMany({
    where: { id: s.id, status: 'KEPT' },
    data: { status: 'READY', decidedAt: null, decidedByUserId: null },
  });
}

function assertMayPost(tenant: Pick<TenantContext, 'capabilities'>, mode: KeepMode) {
  if (mode === 'edit') return;
  for (const capability of [StudioCapability.ProjectApprove, StudioCapability.PublicationWrite])
    if (!hasCapability(tenant, capability))
      throw new ForbiddenError('Scheduling or posting a card approves and publishes it', {
        capability,
      });
}

export async function decide(
  deps: BlitzDeps,
  tenant: TenantContext,
  suggestionId: string,
  input: z.infer<typeof decisionInput>,
): Promise<DecisionResult> {
  const now = deps.now();
  const s = await deps.db.blitzSuggestion.findFirst({
    where: { id: suggestionId, organisationId: tenant.organisationId },
  });
  if (!s || !isFormatKey(s.format)) throw new NotFoundError('Card not found');
  if (s.status !== 'READY')
    throw new ConflictError('This card was already swiped', { code: 'swiped' });
  if ((await swipeCount(deps.db, tenant, now)) >= BLITZ_DAILY_SWIPES)
    throw new RateLimitError('That is today’s swipes; come back tomorrow', 3_600, {
      code: 'swipe_cap',
      max: BLITZ_DAILY_SWIPES,
    });
  const scope = { organisationId: s.organisationId, businessId: s.businessId };
  const angle = s.angleId
    ? await deps.db.contentAngle.findFirst({
        where: { id: s.angleId, ...scope },
        select: { id: true, title: true },
      })
    : null;
  const refill = () =>
    refillNow(deps, tenant, s.businessId).catch((err: unknown) =>
      deps.logger.warn({ err, suggestionId }, 'blitz refill not queued'),
    );

  if (input.action === 'skip') {
    await claim(deps.db, s, 'SKIPPED', tenant.userId, now, input.reason);
    if (s.projectId) {
      await mergeMetadata(deps.db, s.projectId, {
        blitz: { suggestionId: s.id, state: 'skipped' },
      });
      await deps.db.videoProject.updateMany({
        where: { id: s.projectId, organisationId: s.organisationId },
        data: { state: 'ARCHIVED', deletedAt: new Date(now) },
      });
    }
    const notice = await recordSignal(deps.db, scope, tenant.userId, {
      action: 'skip',
      reason: input.reason,
      format: s.format,
      angle,
    });
    await refill();
    return {
      suggestionId: s.id,
      action: 'skip',
      projectId: null,
      publish: null,
      scheduledFor: null,
      downloadOnly: [],
      notice: input.reason ? notice : null,
    };
  }

  assertMayPost(tenant, input.mode);
  await claim(deps.db, s, 'KEPT', tenant.userId, now);
  let result: DecisionResult;
  const card = { ...s, format: s.format as FormatKey };
  try {
    result = isPremade(card.format)
      ? await keepPremade(deps, tenant, card, input.mode)
      : await keepPreview(deps, tenant, card, input.mode);
  } catch (err) {
    await unclaim(deps.db, s);
    throw err;
  }
  await recordSignal(deps.db, scope, tenant.userId, { action: 'keep', format: s.format, angle });
  await notifyQuotaThresholds(deps, tenant).catch(() => undefined);
  await refill();
  return result;
}

async function keepPremade(
  deps: BlitzDeps,
  tenant: TenantContext,
  s: BlitzSuggestion & { format: FormatKey },
  mode: KeepMode,
): Promise<DecisionResult> {
  if (!s.projectId) throw new ConflictError('This card has no render', { code: 'no_render' });
  const project = await findProject(deps.db, tenant.organisationId, s.projectId);
  if (project.state !== 'READY_FOR_REVIEW')
    throw new ConflictError('This card is not ready yet', { code: 'not_ready' });
  // The allowance, exactly as Create's generate: reserved under the lock (packs included).
  const quota = await checkGenerateQuota(deps, tenant, project.id);
  try {
    await deps.db.videoProject.updateMany({
      where: { id: project.id, organisationId: tenant.organisationId },
      data: { sourceRef: null },
    });
    await mergeMetadata(deps.db, project.id, { blitz: { suggestionId: s.id, state: 'kept' } });
  } catch (err) {
    await releaseQuotaReservation(deps, quota.reservation);
    throw err;
  }
  deps.audit({
    actorUserId: tenant.userId,
    organisationId: tenant.organisationId,
    action: 'studio.blitz.keep',
    resource: { type: 'video_project', id: project.id },
    metadata: { suggestionId: s.id, format: s.format, mode },
  });
  return publishKept(deps, tenant, s, project.id, mode);
}

async function publishKept(
  deps: BlitzDeps,
  tenant: TenantContext,
  s: BlitzSuggestion & { format: FormatKey },
  projectId: string,
  mode: KeepMode,
): Promise<DecisionResult> {
  const base: DecisionResult = {
    suggestionId: s.id,
    action: 'keep',
    projectId,
    publish: 'edit',
    scheduledFor: null,
    downloadOnly: [],
    notice: null,
  };
  if (mode === 'edit') return base;
  const scope = { organisationId: s.organisationId, businessId: s.businessId };
  const project = await findProject(deps.db, tenant.organisationId, projectId);
  const formatPlatforms = ((project.targetFormats ?? []) as Array<{ platform?: string }>)
    .map((f) => f.platform)
    .filter((p): p is string => typeof p === 'string');
  const accounts = await accountTargets(deps.db, scope, s.format, {
    now: deps.now(),
    env: deps.env,
    only: formatPlatforms,
  });
  if (accounts.targets.length === 0)
    return { ...base, publish: 'no_accounts', downloadOnly: accounts.downloadOnly };
  const scheduledStartAt =
    mode === 'schedule' ? await nextFreeSlot(deps.db, scope, deps.now()) : null;
  await deps.db.videoProject.updateMany({
    where: { id: projectId, organisationId: tenant.organisationId },
    data: {
      publishPolicy: mode === 'schedule' ? 'SCHEDULED' : 'AUTO_ON_APPROVAL',
      scheduledStartAt,
    },
  });
  await mergeMetadata(deps.db, projectId, { autoPublish: { targets: accounts.targets } });
  const { completed } = await approveWithWorkflow(
    deps.db,
    tenant,
    projectId,
    undefined,
    deps.now(),
  );
  if (!completed)
    return { ...base, publish: 'awaiting_approval', downloadOnly: accounts.downloadOnly };
  const outcome = await publishOnApproval(deps, {
    projectId,
    organisationId: tenant.organisationId,
    planTier: tenant.organisation.planTier ?? '',
    trigger: 'human',
  });
  const firstTime =
    outcome.status !== 'skipped'
      ? (outcome.results.find((r) => r.scheduledFor)?.scheduledFor ?? null)
      : null;
  return {
    ...base,
    publish: mode === 'schedule' ? 'scheduled' : 'posting',
    scheduledFor: firstTime ?? scheduledStartAt?.toISOString() ?? null,
    downloadOnly: accounts.downloadOnly,
  };
}

/** A paid card: the project is created and generated only now (allowance like Create). */
async function keepPreview(
  deps: BlitzDeps,
  tenant: TenantContext,
  s: BlitzSuggestion & { format: FormatKey },
  mode: KeepMode,
): Promise<DecisionResult> {
  const scope = { organisationId: s.organisationId, businessId: s.businessId };
  const copy = copyOf(s);
  const accounts = await accountTargets(deps.db, scope, s.format, {
    now: deps.now(),
    env: deps.env,
  });
  const posting = mode !== 'edit' && accounts.targets.length > 0;
  const platforms = accounts.targets.length
    ? accounts.targets.map((t) => t.platform)
    : (['tiktok', 'instagram_reel'] as const);
  const scheduledStartAt =
    posting && mode === 'schedule' ? await nextFreeSlot(deps.db, scope, deps.now()) : null;
  const latest = await deps.db.videoProject.findFirst({
    where: { ...scope, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { language: true },
  });
  const body = createProjectInput.parse({
    ...projectBodyForCard(s.format, copy, {
      businessId: s.businessId,
      language: latest?.language ?? 'en-GB',
      platforms: [...platforms],
    }),
    ...(posting
      ? {
          reviewPolicy: 'AUTO_APPROVE',
          publishPolicy: mode === 'schedule' ? 'SCHEDULED' : 'AUTO_ON_APPROVAL',
          autoPublish: { targets: accounts.targets },
          ...(scheduledStartAt && { scheduledStartAt: scheduledStartAt.toISOString() }),
        }
      : { reviewPolicy: 'REQUIRE_APPROVAL', publishPolicy: 'MANUAL' }),
  });
  const project = await createProject(deps.db, tenant, body, deps.now());
  await mergeMetadata(deps.db, project.id, {
    blitz: { suggestionId: s.id, state: 'kept' },
    ...(copy.captions && { postCopy: copy.captions as Prisma.InputJsonValue }),
  });
  const quota = await checkGenerateQuota(deps, tenant, project.id).catch(async (err: unknown) => {
    await deps.db.videoProject.updateMany({
      where: { id: project.id, organisationId: tenant.organisationId },
      data: { state: 'ARCHIVED', deletedAt: new Date(deps.now()) },
    });
    throw err;
  });
  try {
    await generateProject(deps, tenant, project.id, {});
  } catch (err) {
    await releaseQuotaReservation(deps, quota.reservation);
    throw err;
  }
  await deps.db.blitzSuggestion.update({ where: { id: s.id }, data: { projectId: project.id } });
  deps.audit({
    actorUserId: tenant.userId,
    organisationId: tenant.organisationId,
    action: 'studio.blitz.keep',
    resource: { type: 'video_project', id: project.id },
    metadata: { suggestionId: s.id, format: s.format, mode, generated: true },
  });
  return {
    suggestionId: s.id,
    action: 'keep',
    projectId: project.id,
    publish:
      mode === 'edit'
        ? 'edit'
        : posting
          ? mode === 'schedule'
            ? 'scheduled'
            : 'posting'
          : 'no_accounts',
    scheduledFor: scheduledStartAt?.toISOString() ?? null,
    downloadOnly: accounts.downloadOnly,
    notice: null,
  };
}

/** Swipes per day across a business (for the admin view and tests). */
export async function decisionsSince(
  db: Pick<PrismaClient, 'blitzSuggestion'>,
  scope: BusinessScope,
  days: number,
  now: number,
) {
  return db.blitzSuggestion.groupBy({
    by: ['status'],
    where: { ...scope, decidedAt: { gte: new Date(now - days * DAY_MS) } },
    _count: { _all: true },
  });
}
