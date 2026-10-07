import type { VideoModelView } from '@/lib/studio/providers/video-model-catalogue';
import type { CreateState, QualityTier } from './body';

// POST /projects/:id/generate body (services/generate-overrides.ts generateOverridesInput) and the
// Create screen's video-model choice (BACKLOG 25.8). The choice is sent as
// preferredProviders.AI_CLIP — the only routed treatment a chosen clip model applies to (UGC actor
// shots are routed by their own actor list and accept no preference). "Automatic" sends nothing.

export type { VideoModelView };

/** GET /api/studio/video-models (prices only for platform staff). */
export interface VideoModelsResponse {
  planTier: QualityTier;
  models: VideoModelView[];
}

export interface GenerateBody {
  qualityTier?: QualityTier;
  preferredProviders?: { AI_CLIP: string[] };
}

/**
 * Whether the chosen format makes AI clips the model choice can steer: AI videos (with or without
 * a template or reference), UGC videos (their non-actor scenes) and a hook + demo whose hook is a
 * generated clip. Slideshows, carousels, uploads and wall of text make none.
 */
export function usesVideoModel(state: Pick<CreateState, 'source' | 'hookDemo'>): boolean {
  if (state.source === 'BRIEF' || state.source === 'UGC') return true;
  return (
    state.source === 'HOOK_DEMO' && (state.hookDemo?.hookSource ?? 'ai_creator') === 'ai_creator'
  );
}

/** The tier this run uses: the lower tier chosen under More options, else the plan's. */
export function runTier(
  state: Pick<CreateState, 'qualityTier'>,
  planTier: QualityTier | undefined,
): QualityTier | undefined {
  return state.qualityTier || planTier;
}

/** The models the server accepts for this run (a candidate on the run's tier). */
export function modelsForTier(
  models: readonly VideoModelView[] | undefined,
  tier: QualityTier | undefined,
): VideoModelView[] {
  if (!models || !tier) return [];
  return models.filter((m) => m.tiers.includes(tier));
}

/**
 * 15.C4 + 25.8: a lower tier for this run, when chosen, and the chosen video model when the
 * format makes AI clips and the model is one the server accepts (`offered`: the providerIds of
 * modelsForTier). A choice the run cannot use is dropped rather than sent to fail validation.
 */
export function buildGenerateBody(
  state: CreateState,
  offered: readonly string[] = [],
): GenerateBody {
  const model = state.videoModel;
  const preferred = model && usesVideoModel(state) && offered.includes(model);
  return {
    ...(state.qualityTier && { qualityTier: state.qualityTier }),
    ...(preferred && { preferredProviders: { AI_CLIP: [model] } }),
  };
}
