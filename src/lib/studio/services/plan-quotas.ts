import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { QuotaExceededError, ValidationError } from '../../errors';
import { logger as rootLogger } from '../../logger';
import type { TenantContext } from '../../tenant';
import { budgetFormatsFromJson } from '../cost/project-budget';
import { notifySafely, type Notifier } from '../notifications/notifier';
import { projectMetadata } from '../pipeline/project-state';
import type { PlanTier } from '../providers/router';
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
//   Standard    "60 × 30s"       "2 × 3min"      "All 8 platforms"
//   Plus        "150 × 30s"      "8 × 6min"      "All 8 + brand voice clone"
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
}

export const DEFAULT_TIER_QUOTAS: Readonly<Record<PlanTier, TierQuota>> = {
  BASIC: {
    shortVideos: 20,
    longVideos: 0,
    shortMaxSec: 30,
    longMaxSec: 0,
    platforms: 'tiktok_instagram_plus_one',
  },
  STANDARD: { shortVideos: 60, longVideos: 2, shortMaxSec: 30, longMaxSec: 180, platforms: 'all' },
  PLUS: { shortVideos: 150, longVideos: 8, shortMaxSec: 30, longMaxSec: 360, platforms: 'all' },
  ENTERPRISE: {
    shortVideos: null,
    longVideos: null,
    shortMaxSec: 30,
    longMaxSec: null,
    platforms: 'all',
  },
};

type Env = Record<string, string | undefined>;

export function quotaMode(env: Env = process.env): QuotaMode {
  const raw = env.STUDIO_QUOTA_MODE?.trim().toLowerCase();
  if (!raw || raw === 'warn') return 'warn';
  if (raw === 'enforce') return 'enforce';
  rootLogger.warn({ value: raw }, '[plan-quotas] invalid STUDIO_QUOTA_MODE; using warn');
  return 'warn';
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
}

function longestSec(project: QuotaProject): number {
  return Math.max(
    0,
    ...budgetFormatsFromJson(project.targetFormats).map((f) => f.durationSec ?? f.duration ?? 0),
  );
}

export function videoKind(project: QuotaProject, quota: TierQuota): VideoKind {
  if (project.sourceType === 'SLIDESHOW') return 'short';
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

export type ViolationCode =
  'short_quota' | 'long_quota' | 'long_not_included' | 'duration' | 'platforms';

export interface QuotaViolation {
  code: ViolationCode;
  message: string;
}

export interface VideoUsage {
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
  const plan = tierLabel(tier);
  if (kind === 'long' && project.sourceType !== 'SLIDESHOW') {
    const sec = longestSec(project);
    if (quota.longVideos === 0 || quota.longMaxSec === 0) {
      out.push({
        code: 'long_not_included',
        message: `The ${plan} plan includes videos up to ${quota.shortMaxSec} s; this one is ${sec} s`,
      });
    } else if (quota.longMaxSec !== null && sec > quota.longMaxSec) {
      out.push({
        code: 'duration',
        message: `The ${plan} plan includes long videos up to ${quota.longMaxSec} s; this one is ${sec} s`,
      });
    }
  }
  if (quota.platforms === 'tiktok_instagram_plus_one') {
    const platforms = [
      ...budgetFormatsFromJson(project.targetFormats).map((f) => f.platform),
      ...extraPlatforms,
    ];
    const extra = new Set(
      platforms.map(familyOf).filter((family) => !BASIC_INCLUDED_FAMILIES.has(family)),
    );
    if (extra.size > BASIC_EXTRA_FAMILIES) {
      out.push({
        code: 'platforms',
        message: `The ${plan} plan publishes to TikTok, Instagram and one more platform; this video targets ${[
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
  usage: VideoUsage;
  quota: TierQuota;
  tier: PlanTier;
}): QuotaViolation[] {
  const { project, quota, tier, usage } = input;
  const out = videoLimitViolations(project, quota, tier);
  if (input.alreadyCounted || out.some((v) => v.code === 'long_not_included')) return out;
  const kind = videoKind(project, quota);
  const limit = kind === 'short' ? quota.shortVideos : quota.longVideos;
  if (limit !== null && usage[kind] >= limit) {
    out.push({
      code: kind === 'short' ? 'short_quota' : 'long_quota',
      message: `The ${tierLabel(tier)} plan includes ${limit} ${kind} videos a month and ${
        usage[kind]
      } have been generated`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ counting

type QuotaDb = Pick<PrismaClient, 'videoProject'>;

/** Projects of the organisation whose generation started in `month`, by kind. */
export async function monthlyVideoUsage(
  db: QuotaDb,
  organisationId: string,
  quota: TierQuota,
  month: MonthWindow,
): Promise<VideoUsage> {
  // generate updates the row, so every project generated this month has updatedAt ≥ its start.
  const rows = await db.videoProject.findMany({
    where: { organisationId, updatedAt: { gte: month.start } },
    select: { sourceType: true, targetFormats: true, metadata: true },
  });
  const usage: VideoUsage = { short: 0, long: 0 };
  for (const row of rows) {
    if (inMonth(generatedAt(row.metadata), month)) usage[videoKind(row, quota)] += 1;
  }
  return usage;
}

function upgradeHint(tier: PlanTier): string {
  const next = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
  return next ? ` Upgrade to ${tierLabel(next)} for more.` : '';
}

export interface QuotaDeps {
  db: QuotaDb;
  logger: Logger;
  now: () => number;
  env?: Env;
}

/**
 * Before POST /projects/:id/generate. enforce → 403 quota_exceeded; warn → logged, allowed.
 * An unknown project is left to generateProject (404).
 */
export async function checkGenerateQuota(
  deps: QuotaDeps,
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  projectId: string,
): Promise<{ violations: QuotaViolation[]; mode: QuotaMode }> {
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
  const usage = await monthlyVideoUsage(deps.db, tenant.organisationId, quota, month);
  const violations = generateViolations({
    project,
    alreadyCounted: inMonth(generatedAt(project.metadata), month),
    usage,
    quota,
    tier,
  });
  raise(deps, mode, tier, violations, { projectId, month: month.key, usage });
  return { violations, mode };
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
): void {
  if (violations.length === 0) return;
  if (mode === 'warn') {
    deps.logger.info({ ...context, planTier: tier, violations }, 'plan quota exceeded (warn)');
    return;
  }
  throw new QuotaExceededError(
    `${violations.map((v) => v.message).join('. ')}.${upgradeHint(tier)}`,
    { planTier: tier, mode, violations, ...context },
  );
}

// ------------------------------------------------------------------ usage view + notifications

export interface QuotaMeter {
  used: number;
  limit: number | null;
  percent: number | null;
  maxDurationSec: number | null;
}

export type QuotaStatus = 'ok' | 'warning' | 'exceeded';

export interface UsageView {
  organisationId: string;
  planTier: PlanTier;
  mode: QuotaMode;
  month: string;
  periodStart: string;
  resetsAt: string;
  thresholds: readonly number[];
  status: QuotaStatus;
  videos: { short: QuotaMeter; long: QuotaMeter };
  platforms: { rule: PlatformRule; description: string };
  scans: { businessesScanned: number; limit: number | null };
  imageGeneration?: ImageGenerationUsage;
}

function meter(used: number, limit: number | null, maxDurationSec: number | null): QuotaMeter {
  const percent = limit === null ? null : limit === 0 ? (used > 0 ? 100 : 0) : (used / limit) * 100;
  return {
    used,
    limit,
    percent: percent === null ? null : Math.round(percent),
    maxDurationSec,
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
): Promise<UsageView> {
  const env = deps.env ?? process.env;
  const quota = tierQuota(tier, env);
  const month = monthWindow(deps.now());
  const [usage, businessesScanned, imageGeneration] = await Promise.all([
    monthlyVideoUsage(deps.db, organisationId, quota, month),
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
    mode: quotaMode(env),
    month: month.key,
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
  },
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
): Promise<number> {
  const tier = toPlanTier(tenant.organisation.planTier);
  let sent = 0;
  try {
    const view = await usageView(deps, tenant.organisationId, tier);
    for (const kind of ['short', 'long'] as const) {
      const m = view.videos[kind];
      for (const threshold of reachedThresholds(m)) {
        await notifySafely(deps, {
          organisationId: tenant.organisationId,
          kind: 'plan_quota',
          title:
            threshold >= 100
              ? `${tierLabel(tier)} plan: ${kind} videos used up for ${view.month}`
              : `${tierLabel(tier)} plan: ${threshold}% of ${kind} videos used`,
          body: `${m.used} of ${m.limit} ${kind} videos generated in ${view.month}. The allowance resets on ${view.resetsAt.slice(
            0,
            10,
          )}.${view.mode === 'enforce' && threshold >= 100 ? ' New generations are blocked until then.' : ''}${upgradeHint(tier)}`,
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
  deps: Parameters<typeof usageView>[0],
  organisationId: string,
  query: z.infer<typeof adminUsageQuery>,
): Promise<
  { tier: { value: PlanTier; source: 'query' | 'last_generation' | 'default' } } & UsageView
> {
  const id = organisationIdParam.safeParse(organisationId);
  if (!id.success) throw new ValidationError('Invalid organisation id');
  const recorded = query.tier ? null : await lastRecordedTier(deps.db, id.data);
  const tier: PlanTier = query.tier ?? recorded ?? 'BASIC';
  const source = query.tier ? 'query' : recorded ? 'last_generation' : 'default';
  const view = await usageView(deps, id.data, tier, query.businessId);
  return { ...view, tier: { value: tier, source } };
}
