import type { VisualTreatment } from '@prisma/client';
import { NoProviderAvailableError, ValidationError } from '../../errors';
import type { KillSwitch } from '../kill-switch';
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
  /** Used for per-candidate cost estimates in the budget check. */
  /** Try this provider first if it is already a candidate for this need and tier. */
  preferredProviderId?: string;
  /** Required: every candidate's cost is estimated from it for the budget check. */
  request: ProviderRequest;
}

export type SkipReason =
  | 'not_configured'
  | 'capability_unsupported'
  | 'provider_disabled'
  | 'over_budget'
  | 'too_slow'
  | 'no_cost_estimate'
  | 'circuit_open';

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

export interface BudgetChecker {
  hasBudget(input: {
    organisationId: string;
    projectId?: string;
    providerId: string;
    estimatedCostPence: number;
  }): Promise<boolean>;
}

/** Optional adapter extensions the router uses when present. */
export interface RoutableAdapter extends ProviderAdapter {
  readonly typicalLatencySec?: number;
  estimateCostPence?(request: ProviderRequest): number;
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
  music: ['suno', 'replicate', 'storyblocks'], // 6.5 Music (MusicGen via Replicate)
  composition: ['shotstack', 'creatomate'], // 6.5 Composition
  transcription: ['assemblyai'], // 6.5 Captions (self-hosted Whisper is not a provider)
  content_safety: ['hive', 'sightengine'], // 6.5 Content safety
};

function aiClipCandidates(tier: PlanTier): string[] {
  // 6.4 defines BASIC only for shots ≤5s; longer BASIC shots use the same cheap tier.
  if (tier === 'BASIC') return ['fal', 'replicate'];
  if (tier === 'STANDARD') return ['luma', 'runway', 'kling'];
  return ['veo', 'runway', 'kling'];
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
      return { capability: 'stock_footage', providerIds: ['storyblocks', 'pexels'] };
    case 'IMAGE_STILL':
      return { capability: 'text_to_image', providerIds: ['openai', 'fal'] };
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
  if (!deps.breaker.tryAcquire(adapter.providerId)) return 'circuit_open';
  return undefined;
}

export async function routeProvider(input: RouteInput, deps: RouterDeps): Promise<RouteDecision> {
  const now = (deps.now ?? Date.now)();
  const plan = planCandidates(input.need, input.planTier);
  const preferred = input.preferredProviderId;
  if (preferred && plan.providerIds.includes(preferred)) {
    // Reorder only: a preference never adds a provider outside the tier's candidate list.
    plan.providerIds = [preferred, ...plan.providerIds.filter((id) => id !== preferred)];
  }
  const candidates: CandidateOutcome[] = [];

  for (const providerId of plan.providerIds) {
    const adapter = deps.registry.findAdapter(providerId) as RoutableAdapter | undefined;
    const skipped = await skipReason(adapter, plan.capability, input, deps, now);
    if (skipped || !adapter) {
      candidates.push({ providerId, skipped: skipped ?? 'not_configured' });
      continue;
    }
    candidates.push({ providerId });
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
