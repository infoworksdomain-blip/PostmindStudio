import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { QuotaExceededError, ValidationError } from '../../errors';
import { logger as rootLogger } from '../../logger';
import type { TenantContext } from '../../tenant';
import { budgetFormatsFromJson } from '../cost/project-budget';
import { notifySafely, type NotificationMessage, type Notifier } from '../notifications/notifier';
import { projectMetadata } from '../pipeline/project-state';
import type { PlanTier } from '../providers/router';
import { allowanceQuartersOf } from '../ugc/allowance';
import { formatVideos, limitInQuarters, quartersToVideos } from '../billing/allowance-units';
import { isUnkeptBlitz } from '../blitz/constants';
import { PLAN_CATALOGUE, TIER_ORDER as CATALOGUE_TIERS } from '../billing/catalogue';
import {
  ALLOWANCE_WINDOW,
  allowancePerWindow,
  allowanceWindowFor,
  blendedAllowance,
  isoWeekWindow,
  isWeekWindowKey,
} from '../billing/plans';
import { consumeCredit } from '../billing/credits';
import type {
  Entitlements,
  EntitlementsReader,
  PlanEntitlement,
} from '../billing/entitlements-reader';
import { withQuotaLock } from '../billing/quota-lock';
import { businessIdParam } from './businesses';
import { toPlanTier, type Platform } from './catalog';
import {
  imageGenerationUsage,
  monthWindow,
  SCANNED_BUSINESS_LIMITS,
  scannedBusinessCount,
  TIER_ORDER,
  tierLabel,
  type ImageGenerationUsage,
  type MonthWindow,
} from './tier-gates';

// Operator decision P3 (2026-09-28) — spec 12.4 "Subscription tier design" included quotas,
// counted per organisation per calendar month (UTC):
//
//   Tier        "Short videos"   "Long videos"   "Platforms"
//   Basic       "20 × 30s"       "0"             "TikTok + IG + 1 more"
//   Standard    "40 × 30s"       "1 × 3min"      "All 8 platforms"
//   Plus        "80 × 30s"       "4 × 6min"      "All 8 + brand voice clone"
//   (Standard and Plus lowered by the 2026-09-30 price list; the numbers live in catalogue.ts.)
//   Enterprise  "Unlimited (fair use)" / "Unlimited"
//
// The numbers are env-configurable defaults (pricing, Playbook A-04, is not signed off):
// STUDIO_QUOTA_<BASIC|STANDARD|PLUS|ENTERPRISE>_<SHORT|LONG|SHORT_MAX_SEC|LONG_MAX_SEC> — a
// non-negative integer or "unlimited". STUDIO_QUOTA_MODE=warn (default) only notifies (in-app, at
// 80 % and 100 %, once per threshold per month) and shows the banner; enforce also answers 403
// quota_exceeded on generate and publish. Overage billing stays with Core (usage events, 15.W2).
//
// Documented choices:
//   · A video is counted in the month its generation starts (POST /projects/:id/generate records
//     metadata.generationStart); regenerating it in the same month does not count again.
//     Counted from video_projects — no counter table. Deleted projects still count.
//   · "Short" is ≤ the tier's short-video length (30 s: "× 30s"); anything longer is a long video,
//     limited to the tier's long-video length ("× 3min" / "× 6min"). Basic has no long videos.
//   · Slideshows count as short videos and are exempt from the length limit (A10.4 prices them
//     separately from AI video).
//   · 23.3 (operator 2026-10-06): usage is counted in integer QUARTERS of a video
//     (billing/allowance-units.ts): a carousel, slideshow, wall of text or hook + demo uses 1, a
//     video 4, a UGC actor video 8. Limits stay in videos and are compared in quarters; the usage
//     view shows videos (5.5 of 8).
//   · "TikTok + IG + 1 more" is checked per video: TikTok, Instagram (Reels / feed) and at most
//     one other platform family (YouTube, Facebook, LinkedIn, X).
//   · Checks are advisory under concurrency: two generate calls racing may both pass the last slot.

export type QuotaMode = 'warn' | 'enforce';
export type VideoKind = 'short' | 'long';
export type PlatformRule = 'tiktok_instagram_plus_one' | 'all';

export const QUOTA_THRESHOLDS = [80, 100] as const;

export interface TierQuota {
  /** Videos per month; null = unlimited. */
  shortVideos: number | null;
  longVideos: number | null;
  /** Longest short video; longer is a long video. */
  shortMaxSec: number;
  /** Longest long video; null = unlimited. */
  longMaxSec: number | null;
  platforms: PlatformRule;
  /** 26.1: the allowance is a Starter / Growth / Pro plan's (messages say "your plan"). */
  studioPlan?: boolean;
  /** 21.5: the window the allowance counts in (default month). */
  period?: 'week' | 'month';
}

/** Phase 18 §P.3: the defaults come from the plan catalogue (env overrides still win). */
export const DEFAULT_TIER_QUOTAS: Readonly<Record<PlanTier, TierQuota>> = Object.freeze(
  Object.fromEntries(
    CATALOGUE_TIERS.map((tier) => {
      const plan = PLAN_CATALOGUE[tier];
      const quota: TierQuota = {
        shortVideos: plan.shortVideosPerMonth,
        longVideos: plan.longVideosPerMonth,
        shortMaxSec: plan.shortMaxSec,
        longMaxSec: plan.longMaxSec,
        platforms: plan.platforms,
      };
      return [tier, quota];
    }),
  ) as Record<PlanTier, TierQuota>,
);

type Env = Record<string, string | undefined>;

/**
 * STUDIO_QUOTA_MODE. Unset: `fallback` — warn in core mode, enforce once Studio bills the
 * organisation itself (Phase 18 §6 "standalone default (was warn)"; callers with entitlements pass
 * 'enforce').
 */
export function quotaMode(env: Env = process.env, fallback: QuotaMode = 'warn'): QuotaMode {
  const raw = env.STUDIO_QUOTA_MODE?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'warn') return 'warn';
  if (raw === 'enforce') return 'enforce';
  rootLogger.warn({ value: raw }, '[plan-quotas] invalid STUDIO_QUOTA_MODE; using warn');
  return 'warn';
}

/**
 * Phase 18 §P.3: the organisation's own allowance — the trial's 5 short + 1 long while trialing,
 * or ENTERPRISE / staff custom limits — on top of the tier's quota.
 */
/**
 * 26.3: a plan's allowance in the window holding `now`: the whole allowance, or, in the window
 * of an upgrade applied mid-period, the blend (plans.ts blendedAllowance). The old plan is
 * measured in the new plan's window (a weekly -> monthly change compares months).
 */
function planAllowance(plan: PlanEntitlement, now: number | undefined): number {
  const full = allowancePerWindow(plan.id, plan.interval);
  const from = plan.changedFrom;
  if (!from || now === undefined) return full;
  const window = allowanceWindowFor(ALLOWANCE_WINDOW[plan.interval], now);
  const old = allowancePerWindow(from.plan, plan.interval);
  return blendedAllowance(old, full, window, Date.parse(from.at));
}

/** `now`: the time the allowance is counted at (blends the window of a mid-period upgrade). */
export function entitlementQuota(
  base: TierQuota,
  entitlements?: Entitlements,
  now?: number,
): TierQuota {
  if (!entitlements) return base;
  if (entitlements.trial) {
    return {
      ...base,
      shortVideos: entitlements.trial.shortVideos,
      longVideos: entitlements.trial.longVideos,
      ...(entitlements.plan && { longMaxSec: 0 }),
    };
  }
  // 26.1: a plan includes its HD videos a month (a week on weekly; yearly per calendar month) and
  // no long videos; staff custom limits still win below.
  const plan = entitlements.plan;
  const withPlan: TierQuota = plan
    ? {
        ...base,
        shortVideos: planAllowance(plan, now),
        longVideos: 0,
        longMaxSec: 0,
        studioPlan: true,
        period: ALLOWANCE_WINDOW[plan.interval],
      }
    : base;
  const custom = entitlements.custom;
  if (!custom) return withPlan;
  return {
    ...withPlan,
    ...(custom.shortVideos !== undefined && { shortVideos: custom.shortVideos }),
    ...(custom.longVideos !== undefined && { longVideos: custom.longVideos }),
    ...(custom.longMaxSec !== undefined && { longMaxSec: custom.longMaxSec }),
  };
}

/**
 * 21.5 / 26.1: the window the allowance is counted in: an ISO week for a weekly plan, the
 * calendar month (UTC) for everything else (monthly, yearly — 8 a month — trials, tiers).
 */
export function allowanceWindow(entitlements: Entitlements | undefined, now: number): MonthWindow {
  const plan = entitlements?.plan;
  const kind = plan && !entitlements?.trial ? ALLOWANCE_WINDOW[plan.interval] : 'month';
  return allowanceWindowFor(kind, now);
}

function envCount(env: Env, name: string, fallback: number | null): number | null {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'unlimited') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  rootLogger.warn({ variable: name, value: raw }, '[plan-quotas] invalid value; using default');
  return fallback;
}

export function tierQuota(tier: PlanTier, env: Env = process.env): TierQuota {
  const d = DEFAULT_TIER_QUOTAS[tier];
  const name = (field: string) => `STUDIO_QUOTA_${tier}_${field}`;
  return {
    shortVideos: envCount(env, name('SHORT'), d.shortVideos),
    longVideos: envCount(env, name('LONG'), d.longVideos),
    shortMaxSec: envCount(env, name('SHORT_MAX_SEC'), d.shortMaxSec) ?? d.shortMaxSec,
    longMaxSec: envCount(env, name('LONG_MAX_SEC'), d.longMaxSec),
    platforms: d.platforms,
  };
}

// ------------------------------------------------------------------ classification

const PLATFORM_FAMILY: Record<Platform, string> = {
  tiktok: 'tiktok',
  instagram_reel: 'instagram',
  instagram_feed: 'instagram',
  youtube_short: 'youtube',
  youtube: 'youtube',
  linkedin_video: 'linkedin',
  x: 'x',
  facebook: 'facebook',
  facebook_feed: 'facebook',
};
const BASIC_INCLUDED_FAMILIES = new Set(['tiktok', 'instagram']);
const BASIC_EXTRA_FAMILIES = 1;

function familyOf(platform: string): string {
  return PLATFORM_FAMILY[platform as Platform] ?? platform;
}

export interface QuotaProject {
  sourceType: string;
  targetFormats: Prisma.JsonValue;
  /** 21.4: read for the allowance units (a UGC actor video uses more than one video). */
  metadata?: Prisma.JsonValue | null;
}

function longestSec(project: QuotaProject): number {
  return Math.max(
    0,
    ...budgetFormatsFromJson(project.targetFormats).map((f) => f.durationSec ?? f.duration ?? 0),
  );
}

export function videoKind(project: QuotaProject, quota: TierQuota): VideoKind {
  // Slideshows and (21.6) carousels are short videos whatever their formats say.
  if (project.sourceType === 'SLIDESHOW' || project.sourceType === 'CAROUSEL') return 'short';
  return longestSec(project) > quota.shortMaxSec ? 'long' : 'short';
}

/** Start of the project's latest generation (metadata.generationStart.at), or null. */
export function generatedAt(metadata: Prisma.JsonValue | null): Date | null {
  const start = projectMetadata(metadata).generationStart as { at?: unknown } | undefined;
  if (!start || typeof start.at !== 'string') return null;
  const at = new Date(start.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

function inMonth(at: Date | null, month: MonthWindow): boolean {
  return at !== null && at >= month.start && at < month.end;
}

/**
 * Phase 18 §8: the slot a locked quota check reserved (metadata.quotaSlot), so a concurrent
 * generate counts it before generateProject records generationStart.
 */
export interface QuotaSlot {
  month: string;
  kind: VideoKind;
  at: string;
  creditUseId?: string;
}

export function quotaSlotOf(metadata: Prisma.JsonValue | null): QuotaSlot | null {
  const slot = projectMetadata(metadata).quotaSlot as Partial<QuotaSlot> | undefined;
  if (!slot || typeof slot.month !== 'string' || (slot.kind !== 'short' && slot.kind !== 'long'))
    return null;
  return {
    month: slot.month,
    kind: slot.kind,
    at: typeof slot.at === 'string' ? slot.at : '',
    ...(typeof slot.creditUseId === 'string' && { creditUseId: slot.creditUseId }),
  };
}

/**
 * Counted in `month`: generation started in it, or a slot was reserved in it. 22.4: a Blitz
 * pre-made render nobody has kept yet is not counted by its generation (a card counts when it is
 * kept, not when it is shown); keeping it reserves a slot, which counts.
 */
function countedIn(metadata: Prisma.JsonValue | null, month: MonthWindow): boolean {
  if (quotaSlotOf(metadata)?.month === month.key) return true;
  return !isUnkeptBlitz(metadata) && inMonth(generatedAt(metadata), month);
}

export type ViolationCode =
  'short_quota' | 'long_quota' | 'long_not_included' | 'duration' | 'platforms';

export interface QuotaViolation {
  code: ViolationCode;
  message: string;
}

/** 23.3: allowance used per kind, in integer quarters of a video (a video = 4). */
export interface QuarterUsage {
  short: number;
  long: number;
}

/** Per-video limits (length, platforms) — pure, shared by generate and publish. */
export function videoLimitViolations(
  project: QuotaProject,
  quota: TierQuota,
  tier: PlanTier,
  extraPlatforms: readonly string[] = [],
): QuotaViolation[] {
  const out: QuotaViolation[] = [];
  const kind = videoKind(project, quota);
  const plan = planText(quota, tier);
  if (kind === 'long' && project.sourceType !== 'SLIDESHOW') {
    const sec = longestSec(project);
    if (quota.longVideos === 0 || quota.longMaxSec === 0) {
      out.push({
        code: 'long_not_included',
        message: `${plan} includes videos up to ${quota.shortMaxSec} s; this one is ${sec} s`,
      });
    } else if (quota.longMaxSec !== null && sec > quota.longMaxSec) {
      out.push({
        code: 'duration',
        message: `${plan} includes long videos up to ${quota.longMaxSec} s; this one is ${sec} s`,
      });
    }
  }
  if (quota.platforms === 'tiktok_instagram_plus_one') {
    // 21.6: a carousel's stored formats list every network it could go to; only the networks it
    // is actually published to count.
    const formatPlatforms =
      project.sourceType === 'CAROUSEL'
        ? []
        : budgetFormatsFromJson(project.targetFormats).map((f) => f.platform);
    const platforms = [...formatPlatforms, ...extraPlatforms];
    const extra = new Set(
      platforms.map(familyOf).filter((family) => !BASIC_INCLUDED_FAMILIES.has(family)),
    );
    if (extra.size > BASIC_EXTRA_FAMILIES) {
      out.push({
        code: 'platforms',
        message: `${plan} publishes to TikTok, Instagram and one more platform; this video targets ${[
          ...extra,
        ].join(', ')}`,
      });
    }
  }
  return out;
}

/** Everything that would stop one more generation of `project` this month. */
export function generateViolations(input: {
  project: QuotaProject;
  alreadyCounted: boolean;
  /** In quarters of a video (monthlyQuarterUsage). */
  usage: QuarterUsage;
  quota: TierQuota;
  tier: PlanTier;
}): QuotaViolation[] {
  const { project, quota, tier, usage } = input;
  const out = videoLimitViolations(project, quota, tier);
  if (input.alreadyCounted || out.some((v) => v.code === 'long_not_included')) return out;
  const kind = videoKind(project, quota);
  const limit = kind === 'short' ? quota.shortVideos : quota.longVideos;
  const limitQuarters = limitInQuarters(limit);
  // 21.4 / 23.3: room for the whole post, in quarters (a quick post 1, a video 4, UGC 8).
  if (limitQuarters !== null && usage[kind] + allowanceQuartersOf(project) > limitQuarters) {
    out.push({
      code: kind === 'short' ? 'short_quota' : 'long_quota',
      message: `${planText(quota, tier)} includes ${limit} ${kind} videos a ${quota.period ?? 'month'} and ${formatVideos(
        usage[kind],
      )} have been used`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ counting

type QuotaDb = Pick<PrismaClient, 'videoProject'>;

/**
 * Allowance used by the organisation's projects counted in `month` (the allowance window), by
 * kind, in integer QUARTERS of a video (23.3).
 */
export async function monthlyQuarterUsage(
  db: QuotaDb,
  organisationId: string,
  quota: TierQuota,
  month: MonthWindow,
): Promise<QuarterUsage> {
  // generate updates the row, so every project generated this month has updatedAt ≥ its start.
  const rows = await db.videoProject.findMany({
    where: { organisationId, updatedAt: { gte: month.start } },
    select: { sourceType: true, targetFormats: true, metadata: true },
  });
  const usage: QuarterUsage = { short: 0, long: 0 };
  for (const row of rows) {
    // 21.4 / 23.3: a UGC actor video uses 8 quarters, a quick post 1, a video 4
    // (ugc/allowance.ts allowanceQuartersOf).
    if (countedIn(row.metadata, month)) usage[videoKind(row, quota)] += allowanceQuartersOf(row);
  }
  return usage;
}

function nextTier(tier: PlanTier): PlanTier | undefined {
  return TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
}

function upgradeHint(tier: PlanTier, quota?: Pick<TierQuota, 'studioPlan'>): string {
  if (quota?.studioPlan) return ' Upgrade your plan or buy a video pack for more.';
  const next = nextTier(tier);
  return next ? ` Upgrade to ${tierLabel(next)} for more.` : '';
}

/** "Your plan" for a Starter / Growth / Pro plan (no tier names for customers), else "The X plan". */
function planText(quota: Pick<TierQuota, 'studioPlan'>, tier: PlanTier): string {
  return quota.studioPlan ? 'Your plan' : `The ${tierLabel(tier)} plan`;
}

/**
 * 16.5: the localisable form of a plan-quota alert (notifications.planQuota*). `nextTier` is the
 * plan label to upgrade to, or 'none' on the top tier (the catalogue selects on it).
 */
export function quotaMessage(
  tier: PlanTier,
  kind: 'short' | 'long',
  threshold: number,
  meter: Pick<QuotaMeter, 'used' | 'limit'>,
  enforce: boolean,
): NotificationMessage {
  const next = nextTier(tier);
  const key =
    threshold < 100 ? 'planQuotaNearing' : enforce ? 'planQuotaBlocked' : 'planQuotaReached';
  return {
    key,
    params: {
      tier: tierLabel(tier),
      kind,
      threshold,
      used: meter.used,
      limit: meter.limit ?? 0,
      nextTier: next ? tierLabel(next) : 'none',
    },
  };
}

export interface QuotaDeps {
  db: QuotaDb & Partial<Pick<PrismaClient, '$transaction'>>;
  logger: Logger;
  now: () => number;
  env?: Env;
  /**
   * Phase 18 (Track C): the organisation's entitlements. Present (standalone billing) = the
   * trial / custom allowance applies, the check runs under the per-(org, month) advisory lock and
   * reserves the slot, and top-up credits cover generations past the allowance.
   */
  entitlements?: EntitlementsReader;
}

/** What a locked check reserved; released again when the generation does not start. */
export interface QuotaReservation {
  projectId: string;
  organisationId: string;
  month: string;
  /** False when the project was already counted this month (nothing new was reserved). */
  fresh: boolean;
  creditUseId?: string;
}

export interface GenerateQuotaResult {
  violations: QuotaViolation[];
  mode: QuotaMode;
  reservation?: QuotaReservation;
}

/**
 * Before POST /projects/:id/generate. enforce → 403 quota_exceeded; warn → logged, allowed.
 * An unknown project is left to generateProject (404).
 */
export async function checkGenerateQuota(
  deps: QuotaDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  projectId: string,
): Promise<GenerateQuotaResult> {
  if (deps.entitlements && deps.db.$transaction)
    return checkGenerateQuotaLocked(deps, deps.entitlements, tenant, projectId);
  const env = deps.env ?? process.env;
  const mode = quotaMode(env);
  const tier = toPlanTier(tenant.organisation.planTier);
  const quota = tierQuota(tier, env);
  const project = await deps.db.videoProject.findFirst({
    where: { id: projectId, organisationId: tenant.organisationId, deletedAt: null },
    select: { sourceType: true, targetFormats: true, metadata: true },
  });
  if (!project) return { violations: [], mode };
  const month = monthWindow(deps.now());
  const usage = await monthlyQuarterUsage(deps.db, tenant.organisationId, quota, month);
  const violations = generateViolations({
    project,
    alreadyCounted: countedIn(project.metadata, month),
    usage,
    quota,
    tier,
  });
  raise(deps, mode, tier, violations, { projectId, month: month.key, usageQuarters: usage });
  return { violations, mode };
}

const QUOTA_CODES = new Set<ViolationCode>(['short_quota', 'long_quota']);

/**
 * Phase 18 §8 / §P.3: the standalone check. Under the per-(org, month) advisory lock it counts,
 * spends one top-up credit when only the monthly allowance is exhausted (enforce mode), and
 * reserves the slot (metadata.quotaSlot) before the lock is released, so two racing generate
 * calls cannot both take the last slot.
 */
async function checkGenerateQuotaLocked(
  deps: QuotaDeps,
  reader: EntitlementsReader,
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  projectId: string,
): Promise<GenerateQuotaResult> {
  const env = deps.env ?? process.env;
  const mode = quotaMode(env, 'enforce');
  const tier = toPlanTier(tenant.organisation.planTier);
  const entitlements = await reader.forOrganisation(tenant.organisationId);
  const now = deps.now();
  const quota = entitlementQuota(tierQuota(tier, env), entitlements, now);
  // 21.5: the allowance window (ISO week for weekly plans); top-up credit uses stay keyed by the
  // calendar month, where their cost-cap headroom is counted (credits.ts creditHeadroomPence).
  const month = allowanceWindow(entitlements, now);
  const creditMonth = monthWindow(now).key;
  const db = deps.db as PrismaClient;
  return withQuotaLock(db, tenant.organisationId, month.key, async (tx) => {
    const project = await tx.videoProject.findFirst({
      where: { id: projectId, organisationId: tenant.organisationId, deletedAt: null },
      select: { sourceType: true, targetFormats: true, metadata: true },
    });
    if (!project) return { violations: [], mode };
    const alreadyCounted = countedIn(project.metadata, month);
    const usage = await monthlyQuarterUsage(tx, tenant.organisationId, quota, month);
    let violations = generateViolations({ project, alreadyCounted, usage, quota, tier });
    const kind = videoKind(project, quota);
    let creditUseId = quotaSlotOf(project.metadata)?.creditUseId;
    const onlyAllowance = violations.length > 0 && violations.every((v) => QUOTA_CODES.has(v.code));
    if (onlyAllowance && mode === 'enforce') {
      const use = await consumeCredit(tx, {
        organisationId: tenant.organisationId,
        projectId,
        month: creditMonth,
        kind,
        now: new Date(now),
        quarters: allowanceQuartersOf(project),
      });
      if (use) {
        creditUseId = use.id;
        violations = [];
        deps.logger.info(
          { projectId, creditId: use.creditId, reused: use.reused, kind },
          'top-up credit used for a generation past the plan allowance',
        );
      }
    }
    raise(
      deps,
      mode,
      tier,
      violations,
      { projectId, month: month.key, usageQuarters: usage },
      quota,
    );
    if (!alreadyCounted) {
      const slot: QuotaSlot = {
        month: month.key,
        kind,
        at: new Date(now).toISOString(),
        ...(creditUseId && { creditUseId }),
      };
      await tx.videoProject.update({
        where: { id: projectId },
        data: {
          metadata: {
            ...projectMetadata(project.metadata),
            quotaSlot: slot,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return {
      violations,
      mode,
      reservation: {
        projectId,
        organisationId: tenant.organisationId,
        month: month.key,
        fresh: !alreadyCounted,
        ...(creditUseId && { creditUseId }),
      },
    };
  });
}

/** The key of the window (of the same kind as `like`: ISO week or month) holding `at`. */
function windowKeyOf(at: Date | null, like: string): string | null {
  if (!at) return null;
  return isWeekWindowKey(like) ? isoWeekWindow(at.getTime()).key : at.toISOString().slice(0, 7);
}

/**
 * The generation did not start after a locked check (generateProject threw): give the slot and
 * any credit it spent back. Never throws (the original error is what the caller reports).
 */
export async function releaseQuotaReservation(
  deps: Pick<QuotaDeps, 'db' | 'logger'>,
  reservation: QuotaReservation | undefined,
): Promise<void> {
  if (!reservation?.fresh || !deps.db.$transaction) return;
  const db = deps.db as PrismaClient;
  try {
    await db.$transaction(async (tx) => {
      const project = await tx.videoProject.findUnique({
        where: { id: reservation.projectId },
        select: { metadata: true },
      });
      if (!project) return;
      // generationStart in the reserved window means the run did start: keep the slot.
      if (windowKeyOf(generatedAt(project.metadata), reservation.month) === reservation.month)
        return;
      const rest = Object.fromEntries(
        Object.entries(projectMetadata(project.metadata)).filter(([k]) => k !== 'quotaSlot'),
      );
      await tx.videoProject.update({
        where: { id: reservation.projectId },
        data: { metadata: rest as Prisma.InputJsonValue },
      });
      if (reservation.creditUseId) {
        const use = await tx.usageCreditUse.findUnique({ where: { id: reservation.creditUseId } });
        if (use) {
          await tx.usageCreditUse.delete({ where: { id: use.id } });
          // 23.3: exactly the quarters this use took (a quick post 1, a video 4, UGC 8).
          await tx.usageCredit.update({
            where: { id: use.creditId },
            data: { remainingQuarters: { increment: use.quarters } },
          });
        }
      }
    });
  } catch (err) {
    deps.logger.error({ err, projectId: reservation.projectId }, 'quota reservation not released');
  }
}

/** Before POST /publications: the per-video platform and length limits. */
export async function checkPublishQuota(
  deps: QuotaDeps & { db: Pick<PrismaClient, 'videoProject' | 'videoRender'> },
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  input: { renderId: string; platform: string },
): Promise<{ violations: QuotaViolation[]; mode: QuotaMode }> {
  const env = deps.env ?? process.env;
  const mode = quotaMode(env);
  const tier = toPlanTier(tenant.organisation.planTier);
  const render = await deps.db.videoRender.findFirst({
    where: { id: input.renderId, project: { organisationId: tenant.organisationId } },
    select: { project: { select: { sourceType: true, targetFormats: true } } },
  });
  if (!render) return { violations: [], mode };
  const violations = videoLimitViolations(render.project, tierQuota(tier, env), tier, [
    input.platform,
  ]);
  raise(deps, mode, tier, violations, { renderId: input.renderId, platform: input.platform });
  return { violations, mode };
}

function raise(
  deps: QuotaDeps,
  mode: QuotaMode,
  tier: PlanTier,
  violations: QuotaViolation[],
  context: Record<string, unknown>,
  quota?: Pick<TierQuota, 'studioPlan'>,
): void {
  if (violations.length === 0) return;
  if (mode === 'warn') {
    deps.logger.info({ ...context, planTier: tier, violations }, 'plan quota exceeded (warn)');
    return;
  }
  throw new QuotaExceededError(
    `${violations.map((v) => v.message).join('. ')}.${upgradeHint(tier, quota)}`,
    {
      planTier: tier,
      mode,
      violations,
      ...context,
      ...(quota?.studioPlan && { studioPlan: true }),
    },
  );
}

// ------------------------------------------------------------------ usage view + notifications

export interface QuotaMeter {
  /** Videos used: 23.3 a quarter number (5.5 = five videos and two quick posts). */
  used: number;
  /** Videos included; null = unlimited. */
  limit: number | null;
  percent: number | null;
  maxDurationSec: number | null;
  /** 23.3: the same in integer quarters of a video (exact; a quick post 1, a video 4). */
  usedQuarters: number;
  limitQuarters: number | null;
}

export type QuotaStatus = 'ok' | 'warning' | 'exceeded';

export interface UsageView {
  organisationId: string;
  planTier: PlanTier;
  mode: QuotaMode;
  /** The allowance window's key: 'YYYY-MM', or 'YYYY-Www' for a weekly plan (21.5). */
  month: string;
  /** 21.5: the allowance window (a weekly plan counts per ISO week). */
  period: 'week' | 'month';
  /** 26.1: the allowance is a Starter / Growth / Pro plan's. */
  studioPlan?: boolean;
  periodStart: string;
  resetsAt: string;
  thresholds: readonly number[];
  status: QuotaStatus;
  videos: { short: QuotaMeter; long: QuotaMeter };
  platforms: { rule: PlatformRule; description: string };
  scans: { businessesScanned: number; limit: number | null };
  imageGeneration?: ImageGenerationUsage;
}

/** A meter from used quarters and a limit in videos (23.3). */
export function meter(
  usedQuarters: number,
  limit: number | null,
  maxDurationSec: number | null,
): QuotaMeter {
  const limitQuarters = limitInQuarters(limit);
  const percent =
    limitQuarters === null
      ? null
      : limitQuarters === 0
        ? usedQuarters > 0
          ? 100
          : 0
        : (usedQuarters / limitQuarters) * 100;
  return {
    used: quartersToVideos(usedQuarters),
    limit,
    percent: percent === null ? null : Math.round(percent),
    maxDurationSec,
    usedQuarters,
    limitQuarters,
  };
}

function statusOf(meters: QuotaMeter[]): QuotaStatus {
  const worst = Math.max(0, ...meters.map((m) => (m.limit ? (m.percent ?? 0) : 0)));
  if (worst >= 100) return 'exceeded';
  if (worst >= QUOTA_THRESHOLDS[0]) return 'warning';
  return 'ok';
}

const PLATFORM_DESCRIPTION: Record<PlatformRule, string> = {
  tiktok_instagram_plus_one: 'TikTok + Instagram + 1 more',
  all: 'All platforms',
};

export async function usageView(
  deps: {
    db: Pick<PrismaClient, 'videoProject' | 'websiteScan' | 'imageLibraryItem'>;
    now: () => number;
    env?: Env;
  },
  organisationId: string,
  tier: PlanTier,
  businessId?: string,
  /** Phase 18: the organisation's entitlements (trial / custom allowance, enforce by default). */
  entitlements?: Entitlements,
): Promise<UsageView> {
  const env = deps.env ?? process.env;
  const now = deps.now();
  const quota = entitlementQuota(tierQuota(tier, env), entitlements, now);
  const month = allowanceWindow(entitlements, now);
  const [usage, businessesScanned, imageGeneration] = await Promise.all([
    monthlyQuarterUsage(deps.db, organisationId, quota, month),
    scannedBusinessCount(deps.db, organisationId),
    businessId
      ? imageGenerationUsage(
          deps.db,
          { organisationId, businessId, planTier: tier },
          deps.now(),
          env,
        )
      : Promise.resolve(undefined),
  ]);
  const videos = {
    short: meter(usage.short, quota.shortVideos, quota.shortMaxSec),
    long: meter(usage.long, quota.longVideos, quota.longMaxSec),
  };
  return {
    organisationId,
    planTier: tier,
    mode: quotaMode(env, entitlements ? 'enforce' : 'warn'),
    month: month.key,
    period: quota.period ?? 'month',
    ...(quota.studioPlan && { studioPlan: true }),
    periodStart: month.start.toISOString(),
    resetsAt: month.end.toISOString(),
    thresholds: QUOTA_THRESHOLDS,
    status: statusOf([videos.short, videos.long]),
    videos,
    platforms: { rule: quota.platforms, description: PLATFORM_DESCRIPTION[quota.platforms] },
    scans: { businessesScanned, limit: SCANNED_BUSINESS_LIMITS[tier] },
    ...(imageGeneration && { imageGeneration }),
  };
}

/**
 * 21.5 / 26.1: the allowance notice for a plan: no tier names, the week or month, and the two
 * ways to keep going (upgrade the plan, buy a video pack). Localised through
 * notifications.videoAllowanceNearing / videoAllowanceUsed.
 */
export function planAllowanceNotice(
  view: Pick<UsageView, 'period' | 'resetsAt'>,
  m: Pick<QuotaMeter, 'used' | 'limit'>,
  threshold: number,
  blocked: boolean,
): { title: string; body: string; message: NotificationMessage } {
  const period = view.period;
  const limit = m.limit ?? 0;
  const resets = view.resetsAt.slice(0, 10);
  if (threshold < 100)
    return {
      title: `${threshold}% of this ${period}'s videos used`,
      body: `${m.used} of ${limit} videos made this ${period}. More are included from ${resets}.`,
      message: {
        key: 'videoAllowanceNearing',
        params: { threshold, used: m.used, limit, period },
      },
    };
  return {
    title: `All of this ${period}'s videos used`,
    body: `${m.used} of ${limit} videos made this ${period}. More are included from ${resets}.${
      blocked ? ' To make more before then, upgrade your plan or buy a video pack.' : ''
    }`,
    message: {
      key: 'videoAllowanceUsed',
      params: {
        used: m.used,
        limit,
        period,
        blocked: blocked ? 'yes' : 'no',
      },
    },
  };
}

/** Thresholds a meter has reached (e.g. [80] at 85 %). */
export function reachedThresholds(m: QuotaMeter): number[] {
  if (!m.limit || m.percent === null) return [];
  return QUOTA_THRESHOLDS.filter((t) => (m.percent ?? 0) >= t);
}

/**
 * After a generation starts: one in-app notification per (month, kind, threshold) reached —
 * idempotent through the notifications dedupeKey. Never throws.
 */
export async function notifyQuotaThresholds(
  deps: {
    db: PrismaClient;
    logger: Logger;
    now: () => number;
    env?: Env;
    notifier?: Notifier;
    /** The organisation's entitlements (the plan's allowance and window). */
    entitlements?: EntitlementsReader;
  },
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
): Promise<number> {
  const tier = toPlanTier(tenant.organisation.planTier);
  let sent = 0;
  try {
    const entitlements = await deps.entitlements?.forOrganisation(tenant.organisationId);
    const view = await usageView(deps, tenant.organisationId, tier, undefined, entitlements);
    for (const kind of ['short', 'long'] as const) {
      const m = view.videos[kind];
      for (const threshold of reachedThresholds(m)) {
        const blocked = view.mode === 'enforce' && threshold >= 100;
        await notifySafely(deps, {
          organisationId: tenant.organisationId,
          kind: 'plan_quota',
          ...(view.studioPlan
            ? planAllowanceNotice(view, m, threshold, blocked)
            : {
                title:
                  threshold >= 100
                    ? `${tierLabel(tier)} plan: ${kind} videos used up for ${view.month}`
                    : `${tierLabel(tier)} plan: ${threshold}% of ${kind} videos used`,
                body: `${m.used} of ${m.limit} ${kind} videos generated in ${view.month}. The allowance resets on ${view.resetsAt.slice(
                  0,
                  10,
                )}.${blocked ? ' New generations are blocked until then.' : ''}${upgradeHint(tier)}`,
                message: quotaMessage(tier, kind, threshold, m, view.mode === 'enforce'),
              }),
          dedupeKey: `plan-quota:${view.month}:${kind}:${threshold}`,
        });
        sent += 1;
      }
    }
  } catch (err) {
    deps.logger.error({ err, organisationId: tenant.organisationId }, 'plan quota alert failed');
  }
  return sent;
}

/** Staff view: the tier last recorded on a generation (Core's tier is only known per request). */
export async function lastRecordedTier(
  db: Pick<PrismaClient, 'videoProject'>,
  organisationId: string,
): Promise<PlanTier | null> {
  const rows = await db.videoProject.findMany({
    where: { organisationId },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { metadata: true },
  });
  for (const row of rows) {
    const recorded = projectMetadata(row.metadata).planTier;
    if (typeof recorded === 'string' && recorded) return toPlanTier(recorded);
  }
  return null;
}

// ------------------------------------------------------------------ API inputs

/** GET /usage?businessId= (the business's image-generation allowance is included when given). */
export const usageQuery = z.object({ businessId: businessIdParam.optional() });

/** GET /admin/organisations/:id/usage?tier= (defaults to the tier last recorded on a generation). */
export const adminUsageQuery = z.object({
  tier: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.enum(['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE']))
    .optional(),
  businessId: businessIdParam.optional(),
});

const organisationIdParam = z.string().trim().min(1).max(128);

export async function organisationUsage(
  deps: Parameters<typeof usageView>[0] & { entitlements?: EntitlementsReader },
  organisationId: string,
  query: z.infer<typeof adminUsageQuery>,
): Promise<
  {
    tier: {
      value: PlanTier;
      source: 'query' | 'entitlements' | 'last_generation' | 'default';
    };
  } & UsageView
> {
  const id = organisationIdParam.safeParse(organisationId);
  if (!id.success) throw new ValidationError('Invalid organisation id');
  // Phase 18 (inventory #19): with Stripe billing the tier is stored (org_entitlements), so staff
  // see the real tier; the tier last recorded on a generation is the core-mode fallback.
  const entitlements =
    query.tier || !deps.entitlements ? undefined : await deps.entitlements.forOrganisation(id.data);
  const stored = entitlements && entitlements.source !== 'none' ? entitlements.tier : null;
  const recorded = query.tier || stored ? null : await lastRecordedTier(deps.db, id.data);
  const tier: PlanTier = query.tier ?? stored ?? recorded ?? 'BASIC';
  const source = query.tier
    ? 'query'
    : stored
      ? 'entitlements'
      : recorded
        ? 'last_generation'
        : 'default';
  const view = await usageView(deps, id.data, tier, query.businessId, entitlements);
  return { ...view, tier: { value: tier, source } };
}
