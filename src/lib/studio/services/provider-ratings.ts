import type { PrismaClient, VisualTreatment } from '@prisma/client';
import { ConfigurationError } from '../../errors';
import { SYSTEM_ACTOR_PREFIX } from '../automation/approval';
import type { ProviderScope } from '../pipeline/deps';
import { planCandidates, type PlanTier, type RouteNeed } from '../providers/router';

// P7 (operator decision 2026-09-28) — per-business provider ratings for Addendum A3.6 step 3:
// "the provider router prefers providers whose recent output was rated stylistically similar".
// The operator defined "rated" as a PER-BUSINESS score from three signals Studio already stores:
//
//   (a) approvalRate     — of this provider's shot outputs that a PERSON approved or rejected
//                          (approval_tasks APPROVED / REJECTED, system auto-approvals excluded),
//                          the share approved. A decision counts for an asset only while that
//                          asset was the shot's live output (created before the decision and not
//                          yet replaced), i.e. it was in the render the reviewer judged.
//   (b) regenerationRate — share of this provider's shot outputs that were later replaced on the
//                          same shot (POST /shots/:id/regenerate or a swap records a newer visual
//                          video_assets row for the shot; the older provider "lost").
//   (c) retention        — mean avgWatchTimePct (latest analytics bucket) of published renders
//                          that contained the provider's output. APPROXIMATION: platforms report
//                          retention per video, not per shot, so a shot inherits the retention
//                          of the whole render(s) built from its script while it was live.
//                          Normalised with spec 15.3's thresholds: <= 25 % → 0, >= 60 % → 1.
//
//   score = Σ wᵢ·componentᵢ / Σ wᵢ over the components that have data, with
//           w(approval) = 0.4, w(1 − regenerationRate) = 0.3, w(retention) = 0.3; clamped to [0, 1].
//
// A provider needs MIN_SAMPLE_SHOTS outputs in the window (default 90 days, matching style
// memory's rolling window) to be rated; approval and retention need MIN_COMPONENT_SAMPLES data
// points each to count. Unrated providers are omitted, so the router treats them as neutral
// (NEUTRAL_SCORE 0.5) and keeps the spec's order among them.
//
// Only providers of generated visual shots (AI_CLIP, IMAGE_STILL, AI_AVATAR, STOCK_FOOTAGE) are
// rated. Providers that ALSO serve a non-visual capability (openai: text/embedding/transcription;
// replicate: music) are shown but not routed on: the router takes one score per provider id, so a
// strong image rating for OpenAI would otherwise push OpenAI text ahead of Claude.

export const DEFAULT_WINDOW_DAYS = 90;
export const MIN_SAMPLE_SHOTS = 5;
export const MIN_COMPONENT_SAMPLES = 3;
export const WEIGHTS = { approval: 0.4, regeneration: 0.3, retention: 0.3 } as const;
export const RETENTION_FLOOR = 0.25;
export const RETENTION_CEILING = 0.6;
export const DEFAULT_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const MAX_CACHE_ENTRIES = 5_000;

const RATED_TREATMENTS: readonly VisualTreatment[] = [
  'AI_CLIP',
  'IMAGE_STILL',
  'AI_AVATAR',
  'STOCK_FOOTAGE',
];
const TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];
type GeneralCapability = Extract<RouteNeed, { kind: 'capability' }>['capability'];
const GENERAL_CAPABILITIES: readonly GeneralCapability[] = [
  'text_generation',
  'embedding',
  'tts',
  'music',
  'sfx',
  'composition',
  'transcription',
  'content_safety',
  'media_analysis',
];

function visualProviderIds(): Set<string> {
  const ids = new Set<string>();
  for (const tier of TIERS) {
    for (const visualTreatment of RATED_TREATMENTS) {
      for (const brandHasCustomAvatar of [false, true]) {
        const plan = planCandidates(
          { kind: 'shot', visualTreatment, durationSec: 5, brandHasCustomAvatar },
          tier,
        );
        plan.providerIds.forEach((id) => ids.add(id));
      }
    }
  }
  return ids;
}

function sharedProviderIds(): Set<string> {
  const ids = new Set<string>();
  for (const capability of GENERAL_CAPABILITIES) {
    planCandidates({ kind: 'capability', capability }, 'ENTERPRISE').providerIds.forEach((id) =>
      ids.add(id),
    );
  }
  return ids;
}

/** Providers the ratings cover (visual shot candidates from the router's lists). */
export const RATED_PROVIDER_IDS: ReadonlySet<string> = visualProviderIds();
/** Rated providers whose score is NOT passed to the router (they also serve other needs). */
export const DISPLAY_ONLY_PROVIDER_IDS: ReadonlySet<string> = new Set(
  [...RATED_PROVIDER_IDS].filter((id) => sharedProviderIds().has(id)),
);

// ---------------------------------------------------------------- formula (pure)

export interface ProviderComponents {
  approvalRate: number | null;
  regenerationRate: number | null;
  retention: number | null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** avgWatchTimePct (0–1) mapped onto spec 15.3's weak (25 %) … strong (60 %) band. */
export function normaliseRetention(avgWatchTimePct: number): number {
  return clamp01((avgWatchTimePct - RETENTION_FLOOR) / (RETENTION_CEILING - RETENTION_FLOOR));
}

/** Weighted mean over the components that have data; null when none has. */
export function scoreFromComponents(c: ProviderComponents): number | null {
  const parts: Array<[number, number]> = [];
  if (c.approvalRate !== null) parts.push([WEIGHTS.approval, clamp01(c.approvalRate)]);
  if (c.regenerationRate !== null)
    parts.push([WEIGHTS.regeneration, 1 - clamp01(c.regenerationRate)]);
  if (c.retention !== null) parts.push([WEIGHTS.retention, normaliseRetention(c.retention)]);
  if (parts.length === 0) return null;
  const weight = parts.reduce((s, [w]) => s + w, 0);
  return round3(clamp01(parts.reduce((s, [w, v]) => s + w * v, 0) / weight));
}

export interface AssetEvidence {
  id: string;
  shotId: string;
  scriptId: string;
  projectId: string;
  visualTreatment: VisualTreatment;
  source: string;
  createdAt: Date;
}

export interface DecisionEvidence {
  projectId: string;
  approved: boolean;
  resolvedAt: Date;
}

export interface RenderEvidence {
  projectId: string;
  scriptId: string;
  createdAt: Date;
  /** Latest avgWatchTimePct of each publication of the render that reported one. */
  retentions: number[];
}

export interface ProviderRating {
  providerId: string;
  score: number;
  components: ProviderComponents;
  sampleShots: number;
  /** False for providers shown for visibility only (see file header). */
  routed: boolean;
}

export const providerOf = (source: string) => source.split(':')[0] ?? source;

interface Tally {
  total: number;
  regenerated: number;
  approved: number;
  decided: number;
  retentions: number[];
}

/** Live interval of each asset: until the next visual asset on the same shot (if any). */
function replacementTimes(assets: readonly AssetEvidence[]): Map<string, Date | null> {
  const byShot = new Map<string, AssetEvidence[]>();
  for (const a of assets) byShot.set(a.shotId, [...(byShot.get(a.shotId) ?? []), a]);
  const replacedAt = new Map<string, Date | null>();
  for (const list of byShot.values()) {
    const sorted = [...list].sort(
      (x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id),
    );
    sorted.forEach((a, i) => replacedAt.set(a.id, sorted[i + 1]?.createdAt ?? null));
  }
  return replacedAt;
}

const liveAt = (at: Date, from: Date, until: Date | null) =>
  at.getTime() >= from.getTime() && (until === null || at.getTime() < until.getTime());

/** Ratings from evidence. `assets` must include every visual asset of the shots (swaps too). */
export function rateProviders(input: {
  assets: readonly AssetEvidence[];
  decisions: readonly DecisionEvidence[];
  renders: readonly RenderEvidence[];
}): ProviderRating[] {
  const replacedAt = replacementTimes(input.assets);
  const decisions = [...input.decisions].sort(
    (a, b) => a.resolvedAt.getTime() - b.resolvedAt.getTime(),
  );
  const tallies = new Map<string, Tally>();
  for (const asset of input.assets) {
    const providerId = providerOf(asset.source);
    if (!RATED_PROVIDER_IDS.has(providerId) || !RATED_TREATMENTS.includes(asset.visualTreatment))
      continue;
    const until = replacedAt.get(asset.id) ?? null;
    const t = tallies.get(providerId) ?? {
      total: 0,
      regenerated: 0,
      approved: 0,
      decided: 0,
      retentions: [],
    };
    t.total += 1;
    if (until !== null) t.regenerated += 1;
    const verdict = decisions.find(
      (d) => d.projectId === asset.projectId && liveAt(d.resolvedAt, asset.createdAt, until),
    );
    if (verdict) {
      t.decided += 1;
      if (verdict.approved) t.approved += 1;
    }
    const retentions = input.renders
      .filter(
        (r) =>
          r.projectId === asset.projectId &&
          r.scriptId === asset.scriptId &&
          liveAt(r.createdAt, asset.createdAt, until),
      )
      .flatMap((r) => r.retentions);
    if (retentions.length > 0)
      t.retentions.push(retentions.reduce((s, r) => s + r, 0) / retentions.length);
    tallies.set(providerId, t);
  }
  const ratings: ProviderRating[] = [];
  for (const [providerId, t] of tallies) {
    if (t.total < MIN_SAMPLE_SHOTS) continue;
    const components: ProviderComponents = {
      approvalRate: t.decided >= MIN_COMPONENT_SAMPLES ? round3(t.approved / t.decided) : null,
      regenerationRate: round3(t.regenerated / t.total),
      retention:
        t.retentions.length >= MIN_COMPONENT_SAMPLES
          ? round3(t.retentions.reduce((s, r) => s + r, 0) / t.retentions.length)
          : null,
    };
    const score = scoreFromComponents(components);
    if (score === null) continue;
    ratings.push({
      providerId,
      score,
      components,
      sampleShots: t.total,
      routed: !DISPLAY_ONLY_PROVIDER_IDS.has(providerId),
    });
  }
  return ratings.sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
}

/** The router's input: routed ratings only. */
export function scoresOf(ratings: readonly ProviderRating[]): Record<string, number> {
  return Object.fromEntries(ratings.filter((r) => r.routed).map((r) => [r.providerId, r.score]));
}

// ---------------------------------------------------------------- data access

type Db = Pick<
  PrismaClient,
  'videoProject' | 'videoAsset' | 'videoShot' | 'approvalTask' | 'videoRender'
>;

export async function loadRatingEvidence(
  db: Db,
  input: { organisationId: string; businessId: string; since: Date },
) {
  const projects = await db.videoProject.findMany({
    where: { organisationId: input.organisationId, businessId: input.businessId, deletedAt: null },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length === 0) return { assets: [], decisions: [], renders: [] };
  const rows = await db.videoAsset.findMany({
    where: {
      organisationId: input.organisationId,
      projectId: { in: projectIds },
      shotId: { not: null },
      kind: { in: ['VIDEO_CLIP', 'IMAGE'] },
      createdAt: { gte: input.since },
    },
    select: { id: true, shotId: true, projectId: true, source: true, createdAt: true },
  });
  const shotIds = [...new Set(rows.flatMap((r) => (r.shotId ? [r.shotId] : [])))];
  const shots = shotIds.length
    ? await db.videoShot.findMany({
        where: { id: { in: shotIds } },
        select: { id: true, scriptId: true, visualTreatment: true },
      })
    : [];
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const assets: AssetEvidence[] = rows.flatMap((r) => {
    const shot = r.shotId ? shotById.get(r.shotId) : undefined;
    return shot
      ? [
          {
            id: r.id,
            shotId: shot.id,
            scriptId: shot.scriptId,
            projectId: r.projectId,
            visualTreatment: shot.visualTreatment,
            source: r.source,
            createdAt: r.createdAt,
          },
        ]
      : [];
  });
  const tasks = await db.approvalTask.findMany({
    where: {
      projectId: { in: projectIds },
      state: { in: ['APPROVED', 'REJECTED'] },
      resolvedAt: { gte: input.since },
      resolvedByUserId: { not: null },
      NOT: { resolvedByUserId: { startsWith: SYSTEM_ACTOR_PREFIX } },
    },
    select: { projectId: true, state: true, resolvedAt: true },
  });
  const decisions: DecisionEvidence[] = tasks.flatMap((t) =>
    t.resolvedAt
      ? [{ projectId: t.projectId, approved: t.state === 'APPROVED', resolvedAt: t.resolvedAt }]
      : [],
  );
  const renderRows = await db.videoRender.findMany({
    where: { projectId: { in: projectIds }, createdAt: { gte: input.since } },
    select: {
      projectId: true,
      scriptId: true,
      createdAt: true,
      publications: {
        where: { state: { in: ['PUBLISHED', 'TAKEN_DOWN'] } },
        select: {
          analytics: {
            orderBy: { bucketAt: 'desc' },
            take: 1,
            select: { avgWatchTimePct: true },
          },
        },
      },
    },
  });
  const renders: RenderEvidence[] = renderRows.map((r) => ({
    projectId: r.projectId,
    scriptId: r.scriptId,
    createdAt: r.createdAt,
    retentions: r.publications.flatMap((p) => {
      const pct = p.analytics[0]?.avgWatchTimePct;
      return typeof pct === 'number' && Number.isFinite(pct) ? [pct] : [];
    }),
  }));
  return { assets, decisions, renders };
}

export async function computeProviderRatings(
  db: Db,
  input: { organisationId: string; businessId: string; now: number; windowDays?: number },
): Promise<ProviderRating[]> {
  const since = new Date(input.now - (input.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS);
  return rateProviders(await loadRatingEvidence(db, { ...input, since }));
}

/** Router scores (0–1) for a business; unrated providers are absent (= neutral). */
export async function computeProviderScores(
  db: Db,
  input: { organisationId: string; businessId: string; now: number; windowDays?: number },
): Promise<Record<string, number>> {
  return scoresOf(await computeProviderRatings(db, input));
}

// ---------------------------------------------------------------- pipeline dependency

export interface ProviderRatings {
  scoresFor(scope: ProviderScope): Promise<Readonly<Record<string, number>>>;
}

/** Cached per (organisation, business) for `ttlMs`; a project's business never changes. */
export function createProviderRatings(input: {
  db: Db;
  now: () => number;
  ttlMs?: number;
  windowDays?: number;
}): ProviderRatings {
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const scores = new Map<string, { expiresAt: number; value: Promise<Record<string, number>> }>();
  const businessOf = new Map<string, string | null>();

  async function resolveBusiness(organisationId: string, projectId: string) {
    const key = `${organisationId}\u0000${projectId}`;
    if (businessOf.has(key)) return businessOf.get(key) ?? null;
    const project = await input.db.videoProject.findFirst({
      where: { id: projectId, organisationId },
      select: { businessId: true },
    });
    if (businessOf.size >= MAX_CACHE_ENTRIES) businessOf.clear();
    businessOf.set(key, project?.businessId ?? null);
    return project?.businessId ?? null;
  }

  return {
    async scoresFor(scope) {
      if (!scope.projectId) return {};
      const businessId = await resolveBusiness(scope.organisationId, scope.projectId);
      if (!businessId) return {};
      const key = `${scope.organisationId}\u0000${businessId}`;
      const now = input.now();
      const cached = scores.get(key);
      if (cached && cached.expiresAt > now) return cached.value;
      if (scores.size >= MAX_CACHE_ENTRIES) scores.clear();
      const value = computeProviderScores(input.db, {
        organisationId: scope.organisationId,
        businessId,
        now,
        windowDays: input.windowDays,
      });
      scores.set(key, { expiresAt: now + ttlMs, value });
      // A failed computation is not cached: the next shot tries again.
      value.catch(() => {
        if (scores.get(key)?.value === value) scores.delete(key);
      });
      return value;
    },
  };
}

/** STUDIO_PROVIDER_RATINGS: "on" (default) or "off". */
export function providerRatingsEnabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  if (!v || v === 'on') return true;
  if (v === 'off') return false;
  throw new ConfigurationError(`STUDIO_PROVIDER_RATINGS must be "on" or "off" (got "${value}")`);
}
