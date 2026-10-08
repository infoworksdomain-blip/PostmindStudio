import { FalAdapter } from './fal';
import {
  FAL_VIDEO_MODELS,
  H3_MAX_SEC,
  H3_RATIOS,
  LTX_DURATIONS,
  PORTRAIT_LANDSCAPE,
  VEO_LITE_DURATIONS,
  type FalVideoModelKey,
} from './fal-models';
import type { AspectRatio } from './interface';
import { KLING_RATIO, KlingAdapter, MAX_CLIP_SEC as KLING_MAX_SEC, type KlingModel } from './kling';
import * as luma from './luma';
import type { ProviderRegistry } from './registry';
import { planCandidates, type PlanTier, type RoutableAdapter } from './router';
import * as runway from './runway';
import { SEEDANCE_MODELS, SEEDANCE_RATIO, SeedanceAdapter, type SeedanceModel } from './seedance';
import { VEO_DURATIONS, VEO_RATIO, VeoAdapter, type VeoModel } from './veo';

// BACKLOG 25.8 (model selector) — the AI-clip video models Create can offer, derived from what the
// router can really use: a provider is listed only when it is REGISTERED (its key is set, so the
// default registry built it) AND it is an AI_CLIP candidate on the organisation's plan tier
// (router.ts aiClipCandidates). Everything shown comes from the adapters: capabilities, typical
// latency, the configured model's name, the clip lengths and native ratios the adapter sends, and
// the cost of a 6 s 9:16 720p clip from the adapter's own estimate (its price constants converted
// with STUDIO_USD_TO_GBP_RATE). Nothing here is a secret: no keys, no URLs.
//
// Audio: Studio asks every provider for SILENT AI clips (Seedance generate_audio false, Kling audio
// "off", fal generate_audio false) and the composer mutes Veo's always-on audio (pipeline/edl.ts);
// narration and music carry the sound. So `audio` is false for every AI-clip model, and the UI
// shows no audio control. No adapter accepts camera, motion or resolution controls from a brief
// either (720p comes from clip-budget.ts), so the catalogue exposes none.

export const CATALOGUE_PROBE_SEC = 6;
const PROBE_RATIO: AspectRatio = '9:16';
const ASPECT_RATIOS: readonly AspectRatio[] = ['9:16', '16:9', '1:1', '4:5'];
const PLAN_TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

export type ClipCapability = 'text_to_video' | 'image_to_video';

export interface VideoModelEntry {
  providerId: string;
  /** The product name as marketed ("Seedance 2.0", "Veo 3.1 Fast", …). */
  displayName: string;
  capabilities: ClipCapability[];
  /** The longest clip the configured model renders, in seconds. */
  maxClipSec: number;
  /** Studio formats the model renders natively (the others are cropped by the composer). */
  aspectRatios: AspectRatio[];
  /** Always false: AI clips are silent in Studio (see above). */
  audio: false;
  /** Estimated cost of one 6 s 9:16 720p clip, in pence (the adapter's own estimate). */
  pencePerClip: number;
  /** 1 = among the cheapest available, 2 = up to twice the cheapest, 3 = dearer. */
  relativeCost: 1 | 2 | 3;
  /** The adapter's typical time for one clip, in seconds (router deadline hint). */
  typicalLatencySec: number | null;
  /** Plan tiers at or below the organisation's where the router may use it for AI clips. */
  tiers: PlanTier[];
}

const SEEDANCE_NAMES: Record<SeedanceModel, string> = {
  'dreamina-seedance-2-0-mini-260615': 'Seedance 2.0 Mini',
  'dreamina-seedance-2-0-fast-260128': 'Seedance 2.0 Fast',
  'dreamina-seedance-2-0-260128': 'Seedance 2.0',
  'dreamina-seedance-2-5-260628': 'Seedance 2.5',
};

const VEO_NAMES: Record<VeoModel, string> = {
  'veo-3.1-generate-preview': 'Veo 3.1',
  'veo-3.1-fast-generate-preview': 'Veo 3.1 Fast',
  'veo-3.1-lite-generate-preview': 'Veo 3.1 Lite',
};

const KLING_NAMES: Record<KlingModel, string> = { 'kling-3.0': 'Kling 3.0' };

/** Luma and Runway run one fixed model each (luma.ts MODEL, runway.ts TEXT_TO_VIDEO_MODEL). */
const MODEL_NAMES: Readonly<Record<string, string>> = {
  'ray-3.2': 'Luma Ray 3.2',
  'gen4.5': 'Runway Gen-4.5',
};

const FAL_LIMITS: Record<FalVideoModelKey, { maxSec: number; ratios: AspectRatio[] }> = {
  'minimax-h3-max': { maxSec: H3_MAX_SEC, ratios: nativeRatios(H3_RATIOS) },
  'ltx-2.3-fast': { maxSec: Math.max(...LTX_DURATIONS), ratios: nativeRatios(PORTRAIT_LANDSCAPE) },
  'veo-3.1-lite': {
    maxSec: Math.max(...VEO_LITE_DURATIONS),
    ratios: nativeRatios(PORTRAIT_LANDSCAPE),
  },
};

/** The Studio ratios a provider's ratio table sends unchanged (no nearest-ratio crop). */
export function nativeRatios(map: Partial<Record<AspectRatio, string>>): AspectRatio[] {
  return ASPECT_RATIOS.filter((r) => map[r] === r);
}

interface Described {
  displayName: string;
  maxClipSec: number;
  aspectRatios: AspectRatio[];
}

/** Name, longest clip and native ratios of a registered adapter (its configured model). */
function describe(adapter: RoutableAdapter, tier: PlanTier): Described | undefined {
  if (adapter instanceof SeedanceAdapter) {
    const model = adapter.tierModel(tier);
    return {
      displayName: SEEDANCE_NAMES[model],
      maxClipSec: Math.max(
        SEEDANCE_MODELS[model].maxSec,
        SEEDANCE_MODELS[adapter.longModel].maxSec,
      ),
      aspectRatios: nativeRatios(SEEDANCE_RATIO),
    };
  }
  if (adapter instanceof VeoAdapter) {
    return {
      displayName: VEO_NAMES[adapter.model],
      maxClipSec: Math.max(...VEO_DURATIONS),
      aspectRatios: nativeRatios(VEO_RATIO),
    };
  }
  if (adapter instanceof KlingAdapter) {
    return {
      displayName: KLING_NAMES[adapter.model],
      maxClipSec: KLING_MAX_SEC,
      aspectRatios: nativeRatios(KLING_RATIO),
    };
  }
  if (adapter instanceof FalAdapter) {
    const models = adapter.models;
    return {
      displayName: `fal.ai: ${models.map((m) => FAL_VIDEO_MODELS[m].label).join(', ')}`,
      maxClipSec: Math.max(...models.map((m) => FAL_LIMITS[m].maxSec)),
      aspectRatios: ASPECT_RATIOS.filter((r) =>
        models.some((m) => FAL_LIMITS[m].ratios.includes(r)),
      ),
    };
  }
  return describeByProviderId(adapter.providerId);
}

/** Luma and Runway: no per-instance model to read. */
function describeByProviderId(providerId: string): Described | undefined {
  if (providerId === luma.PROVIDER_ID) {
    return {
      displayName: MODEL_NAMES[luma.MODEL] ?? `Luma ${luma.MODEL}`,
      maxClipSec: luma.MAX_DURATION_SEC,
      aspectRatios: nativeRatios(luma.RATIO),
    };
  }
  if (providerId === runway.PROVIDER_ID) {
    return {
      displayName:
        MODEL_NAMES[runway.TEXT_TO_VIDEO_MODEL] ?? `Runway ${runway.TEXT_TO_VIDEO_MODEL}`,
      maxClipSec: runway.MAX_DURATION_SEC,
      // Runway's table maps ratios to pixel sizes; a ratio it lists is rendered natively.
      aspectRatios: ASPECT_RATIOS.filter((r) => runway.RATIO.text_to_video[r] !== undefined),
    };
  }
  return undefined;
}

/** Tiers at or below `planTier` whose AI_CLIP candidate list names the provider. */
export function aiClipTiers(providerId: string, planTier: PlanTier): PlanTier[] {
  const upTo = PLAN_TIERS.slice(0, PLAN_TIERS.indexOf(planTier) + 1);
  return upTo.filter((tier) => aiClipCandidateIds(tier).includes(providerId));
}

export function aiClipCandidateIds(tier: PlanTier): string[] {
  return planCandidates({ kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 5 }, tier)
    .providerIds;
}

function probeCostPence(adapter: RoutableAdapter, tier: PlanTier): number {
  if (!adapter.estimateCostPence) return 0;
  return adapter.estimateCostPence({
    capability: 'text_to_video',
    organisationId: 'video-model-catalogue',
    prompt: 'catalogue estimate',
    durationSec: CATALOGUE_PROBE_SEC,
    aspectRatio: PROBE_RATIO,
    resolution: '720p',
    planTier: tier,
  });
}

/** 1 within 30 % of the cheapest, 2 up to twice the cheapest, 3 above. */
export function relativeCostOf(pence: number, cheapest: number): 1 | 2 | 3 {
  if (cheapest <= 0 || pence <= cheapest * 1.3) return 1;
  return pence <= cheapest * 2 ? 2 : 3;
}

/**
 * The AI-clip models this organisation can pick, in the router's order for its plan tier (the
 * order "Automatic" tries them in). Unregistered providers and providers outside the tier's
 * candidate list are left out.
 */
export function buildVideoModelCatalogue(
  registry: Pick<ProviderRegistry, 'findAdapter'>,
  planTier: PlanTier,
): VideoModelEntry[] {
  const found = aiClipCandidateIds(planTier).flatMap((providerId) => {
    const adapter: RoutableAdapter | undefined = registry.findAdapter(providerId);
    if (!adapter) return [];
    const capabilities = adapter.capabilities.filter(
      (c): c is ClipCapability => c === 'text_to_video' || c === 'image_to_video',
    );
    const described = describe(adapter, planTier);
    if (capabilities.length === 0 || !described) return [];
    return [{ adapter, capabilities, described }];
  });
  const costs = found.map(({ adapter }) => probeCostPence(adapter, planTier));
  const priced = costs.filter((c) => c > 0);
  const cheapest = priced.length ? Math.min(...priced) : 0;
  return found.map(({ adapter, capabilities, described }, i) => {
    const pencePerClip = costs[i] ?? 0;
    return {
      providerId: adapter.providerId,
      ...described,
      capabilities,
      audio: false,
      pencePerClip,
      relativeCost: relativeCostOf(pencePerClip, cheapest),
      typicalLatencySec: adapter.typicalLatencySec ?? null,
      tiers: aiClipTiers(adapter.providerId, planTier),
    };
  });
}

/** What a viewer receives: the cost fields only for platform staff (operator decision 2026-10-04). */
export type VideoModelView = Omit<VideoModelEntry, 'pencePerClip' | 'relativeCost'> &
  Partial<Pick<VideoModelEntry, 'pencePerClip' | 'relativeCost'>>;

/** Customers never see generation cost: drop the price and the relative-cost bucket. */
export function withoutCosts(entry: VideoModelEntry): VideoModelView {
  const { pencePerClip: _pence, relativeCost: _relative, ...rest } = entry;
  return rest;
}
