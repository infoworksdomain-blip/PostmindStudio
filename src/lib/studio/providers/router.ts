import type { VisualTreatment } from '@prisma/client';
import { NoProviderAvailableError, ValidationError } from '../../errors';
import type { KillSwitch } from '../kill-switch';
import { getMetrics } from '../observability/metrics';
import type { CircuitBreaker } from './circuit-breaker';
import type { ProviderAdapter, ProviderCapability, ProviderRequest } from './interface';
import type { ProviderRegistry } from './registry';

// BACKLOG 2.9 — provider router (spec 6.4, candidate lists from 6.4 and primary/fallback
// pairs from 5.2 and 6.5). Each candidate is tried in order and skipped if it is not
// configured, cannot do the job, is disabled by the level-4 kill switch, would exceed budget,
// is too slow for the deadline, or has an open circuit breaker. The full decision (including
// skip reasons) is returned so workers can store it in video_shots.providerRouting.
//
// DECISIONS beyond the spec text (flag at GATE 2):
//   - BASIC plan AI_CLIP shots over 5s: 6.4 defines no list, so they use the cheap-tier list.
//   - AI_AVATAR: 6.1 requires a fallback for every shot type, so D-ID and HeyGen back each
//     other up (except a brand's custom HeyGen avatar, which cannot move provider).
//   - AI_CLIP on PLUS/ENTERPRISE (BACKLOG 13.32): Luma is added after Runway. 6.4 lists
//     [Veo, Runway, Kling], but 6.1 requires a working fallback and the playbook names Luma
//     the "text-to-video fallback" ("toggle Runway off; verify router fails over to Luma").
//     Kling has no adapter, so without Luma an open Runway breaker would leave PLUS clips with
//     no provider. STANDARD keeps the spec's Luma-first order.
//   - BACKLOG 20.20 (operator decision 2026-10-02): Google Veo 3.1 (providers/veo.ts) is the
//     THIRD AI_CLIP option on STANDARD, PLUS and ENTERPRISE, after Runway and Luma, so it is a
//     failover by default rather than the first choice 6.4 gives "Veo" on PLUS. Veo renders at
//     most 8 s; longer shots skip it (supportsRequest → capability_unsupported).
//   - BACKLOG 20.24 (operator decision 2026-10-02): approved order Seedance → Kling 3 → Veo 3.1
//     Fast → Runway → Luma on STANDARD, PLUS and ENTERPRISE. Seedance (p20-byteplus-seedance)
//     is not on main yet, so the order here is kling → veo → runway → luma; the Seedance PR puts
//     seedance first. Kling renders 3–15 s (supportsRequest), so it takes the longest shots.

export type PlanTier = 'BASIC' | 'STANDARD' | 'PLUS' | 'ENTERPRISE';

const TIER_RANK: Record<PlanTier, number> = { BASIC: 0, STANDARD: 1, PLUS: 2, ENTERPRISE: 3 };

export type RouteNeed =
  | {
      kind: 'shot';
      visualTreatment: VisualTreatment;
      durationSec: number;
      hasSourceImage?: boolean;
      brandHasCustomAvatar?: boolean;
    }
  | {
      kind: 'capability';
      capability: Exclude<
        ProviderCapability,
        'text_to_video' | 'image_to_video' | 'avatar_video' | 'stock_footage' | 'text_to_image'
      >;
    };

export interface RouteInput {
  need: RouteNeed;
  planTier: PlanTier;
  organisationId: string;
  projectId?: string;
  /** Latest acceptable completion time; providers slower than this are skipped. */
  deadline?: Date;
  /**
   * Try this provider (or these, in order) first if already candidates for this need and tier.
   * 15.C4: a generate body's preferredProviders arrive here as a list.
   */
  preferredProviderId?: string | readonly string[];
  /**
   * P7 (A3.6 step 3): per-business provider scores in [0, 1]. Candidates without a score count
   * as NEUTRAL_SCORE; a stable sort keeps the spec order among equal scores. Explicit
   * preferences above still go first.
   */
  providerScores?: Readonly<Record<string, number>>;
  /** Required: every candidate's cost is estimated from it for the budget check. */
  request: ProviderRequest;
  /**
   * 20.11: providers this operation already tried and lost to an account problem (bad key, no
   * credits, usage limit); skipped as `account_unavailable` so the next candidate is chosen.
   */
  excludeProviderIds?: readonly string[];
}

export const NEUTRAL_SCORE = 0.5;

/** Stable sort by score, highest first; unrated providers count as neutral. */
export function orderByScore(
  providerIds: readonly string[],
  scores: Readonly<Record<string, number>> | undefined,
): string[] {
  if (!scores || Object.keys(scores).length === 0) return [...providerIds];
  const scoreOf = (id: string) => {
    const s = scores[id];
    return typeof s === 'number' && Number.isFinite(s) ? s : NEUTRAL_SCORE;
  };
  return providerIds
    .map((id, index) => ({ id, index, score: scoreOf(id) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((c) => c.id);
}

export type SkipReason =
  | 'not_configured'
  | 'capability_unsupported'
  | 'provider_disabled'
  | 'over_budget'
  | 'too_slow'
  | 'no_cost_estimate'
  | 'circuit_open'
  | 'account_unavailable';

const STATIC_SKIP_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'not_configured',
  'capability_unsupported',
]);

export interface CandidateOutcome {
  providerId: string;
  skipped?: SkipReason;
}

export interface RouteDecision {
  providerId: string;
  adapter: ProviderAdapter;
  capability: ProviderCapability;
  candidates: CandidateOutcome[];
  decidedAt: string;
}

export interface SpendScope {
  organisationId: string;
  projectId?: string;
  planTier: PlanTier;
}

export interface BudgetChecker {
  hasBudget(input: {
    organisationId: string;
    projectId?: string;
    providerId: string;
    estimatedCostPence: number;
  }): Promise<boolean>;
  /**
   * Spec 12.5 pause (cost/guard.ts): throws CostCapPausedError when a project, organisation or
   * global cap pauses generation. Checked once per routing, before any candidate.
   */
  assertNotPaused?(scope: SpendScope): Promise<void>;
  /** Raise the cost alerts crossed after spend was reserved or settled. Never throws. */
  recordSpend?(scope: SpendScope & { providerId: string }): Promise<void>;
}

/** Optional adapter extensions the router uses when present. */
export interface RoutableAdapter extends ProviderAdapter {
  readonly typicalLatencySec?: number;
  estimateCostPence?(request: ProviderRequest): number;
  /**
   * 20.20: false when the adapter cannot serve this particular request (e.g. Veo renders at most
   * 8 s), so the router moves on (`capability_unsupported`) instead of failing at submit.
   */
  supportsRequest?(request: ProviderRequest): boolean;
}

export interface RouterDeps {
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  killSwitch: Pick<KillSwitch, 'check'>;
  budget: BudgetChecker;
  now?: () => number;
}

interface CandidatePlan {
  capability: ProviderCapability;
  providerIds: string[];
}

type GeneralCapability = Extract<RouteNeed, { kind: 'capability' }>['capability'];

const CAPABILITY_CANDIDATES: Record<GeneralCapability, string[]> = {
  text_generation: ['anthropic', 'openai'], // 5.2: Claude Sonnet, GPT-4o fallback
  embedding: ['openai'],
  tts: ['elevenlabs', 'azure-speech'], // 6.5 Voice
  // 6.5 Music. SPEC DRIFT: Suno (no public API) replaced by ElevenLabs Music. 15.C2: the
  // Storyblocks library pick (spec 5.6) is the built fallback; MusicGen via Replicate is not built.
  music: ['elevenlabs-music', 'storyblocks-music', 'replicate'],
  // BACKLOG 13.27: Storyblocks audio catalogue, content_type=sfx (providers/storyblocks-audio.ts).
  sfx: ['storyblocks-audio'],
  composition: ['shotstack', 'creatomate'], // 6.5 Composition
  // 6.5 Captions. 15.C1: OpenAI's hosted Whisper (whisper-1) is the fallback.
  transcription: ['assemblyai', 'openai'],
  // 6.5 Content safety. 20.21 (operator decision 2026-10-02): Hive was removed and no other
  // content-safety provider is built, so nothing is routed here and the quality gate records the
  // scan as skipped (queue/workers/run-quality-gate.ts). A new provider is added to this list.
  content_safety: [],
  // 13.36: no inference host is chosen, so nothing is ever routed here; the media-analysis
  // adapter (providers/media-analysis.ts) reports unhealthy and is not registered.
  media_analysis: [],
};

function aiClipCandidates(tier: PlanTier): string[] {
  // 6.4 defines BASIC only for shots ≤5s; longer BASIC shots use the same cheap tier.
  if (tier === 'BASIC') return ['fal', 'replicate'];
  // 20.24: every paid tier tries the same order (premium choices happen inside an adapter).
  return ['kling', 'veo', 'runway', 'luma'];
}

function avatarCandidates(tier: PlanTier, brandHasCustomAvatar: boolean): string[] {
  if (brandHasCustomAvatar) return ['heygen'];
  return TIER_RANK[tier] <= TIER_RANK.STANDARD ? ['d-id', 'heygen'] : ['heygen', 'd-id'];
}

export function planCandidates(need: RouteNeed, tier: PlanTier): CandidatePlan {
  if (need.kind === 'capability') {
    return { capability: need.capability, providerIds: CAPABILITY_CANDIDATES[need.capability] };
  }
  switch (need.visualTreatment) {
    case 'AI_CLIP':
      return {
        capability: need.hasSourceImage ? 'image_to_video' : 'text_to_video',
        providerIds: aiClipCandidates(tier),
      };
    case 'AI_AVATAR':
      return {
        capability: 'avatar_video',
        providerIds: avatarCandidates(tier, need.brandHasCustomAvatar ?? false),
      };
    case 'STOCK_FOOTAGE':
      // Phase 15 (13.38 correction): Storyblocks video catalogue, then Pexels videos.
      return { capability: 'stock_footage', providerIds: ['storyblocks-video', 'pexels-video'] };
    case 'IMAGE_STILL':
      // 15.W6 (spec 6.5 / A6.5 "DALL-E 3 or Ideogram"): the Ideogram slot is last and is only
      // eligible when an Ideogram adapter is registered, which default-registry never does until
      // an Ideogram account and key exist (providers/ideogram.ts); unregistered = skipped.
      return { capability: 'text_to_image', providerIds: ['openai', 'fal', 'ideogram'] };
    case 'MOTION_GRAPHICS':
    case 'USER_UPLOAD':
    case 'TEXT_CARD':
    case 'TRANSITION':
      throw new ValidationError(
        `${need.visualTreatment} shots are built by composition, not a generation provider`,
      );
  }
}

async function skipReason(
  adapter: RoutableAdapter | undefined,
  capability: ProviderCapability,
  input: RouteInput,
  deps: RouterDeps,
  now: number,
): Promise<SkipReason | undefined> {
  if (!adapter) return 'not_configured';
  if (!adapter.capabilities.includes(capability)) return 'capability_unsupported';
  if (adapter.supportsRequest && !adapter.supportsRequest(input.request)) {
    return 'capability_unsupported';
  }
  if (input.excludeProviderIds?.includes(adapter.providerId)) return 'account_unavailable';

  const kill = await deps.killSwitch.check({
    organisationId: input.organisationId,
    projectId: input.projectId,
    providerId: adapter.providerId,
  });
  if (kill.killed && kill.level === 'provider') return 'provider_disabled';

  // Fail closed: a provider that cannot estimate cost cannot be budget-checked.
  if (!adapter.estimateCostPence) return 'no_cost_estimate';
  const estimatedCostPence = adapter.estimateCostPence(input.request);
  const withinBudget = await deps.budget.hasBudget({
    organisationId: input.organisationId,
    projectId: input.projectId,
    providerId: adapter.providerId,
    estimatedCostPence,
  });
  if (!withinBudget) return 'over_budget';

  if (input.deadline && adapter.typicalLatencySec !== undefined) {
    if (now + adapter.typicalLatencySec * 1000 > input.deadline.getTime()) return 'too_slow';
  }

  // Last, because in half-open state this claims the single trial request.
  if (!(await deps.breaker.tryAcquire(adapter.providerId))) return 'circuit_open';
  return undefined;
}

export async function routeProvider(input: RouteInput, deps: RouterDeps): Promise<RouteDecision> {
  const now = (deps.now ?? Date.now)();
  const plan = planCandidates(input.need, input.planTier);
  await deps.budget.assertNotPaused?.({
    organisationId: input.organisationId,
    projectId: input.projectId,
    planTier: input.planTier,
  });
  const preferred = (
    typeof input.preferredProviderId === 'string'
      ? [input.preferredProviderId]
      : (input.preferredProviderId ?? [])
  ).filter((id) => plan.providerIds.includes(id));
  // P7 scores rate shot visuals, so they only reorder shot routing (never text, voice, music).
  const rest = orderByScore(
    plan.providerIds.filter((id) => !preferred.includes(id)),
    input.need.kind === 'shot' ? input.providerScores : undefined,
  );
  // Reorder only: neither a preference nor a rating adds a provider outside the tier's list.
  plan.providerIds = [...preferred, ...rest];
  const candidates: CandidateOutcome[] = [];

  for (const providerId of plan.providerIds) {
    const adapter = deps.registry.findAdapter(providerId) as RoutableAdapter | undefined;
    const skipped = await skipReason(adapter, plan.capability, input, deps, now);
    if (skipped || !adapter) {
      candidates.push({ providerId, skipped: skipped ?? 'not_configured' });
      // 17.4: failover metric — only run-time reasons (a provider this deployment does not
      // configure, or that cannot do the job, is not failing over).
      if (skipped && !STATIC_SKIP_REASONS.has(skipped))
        getMetrics().providerPassedOver.inc({ provider: providerId, reason: skipped });
      continue;
    }
    candidates.push({ providerId });
    getMetrics().providerSelected.inc({ provider: providerId });
    return {
      providerId,
      adapter,
      capability: plan.capability,
      candidates,
      decidedAt: new Date(now).toISOString(),
    };
  }

  throw new NoProviderAvailableError(`No provider available for ${plan.capability}`, {
    capability: plan.capability,
    candidates,
  });
}
