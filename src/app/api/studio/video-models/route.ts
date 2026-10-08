import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import {
  buildVideoModelCatalogue,
  withoutCosts,
} from '@/lib/studio/providers/video-model-catalogue';
import { isCostViewer } from '@/lib/studio/services/cost-viewer';
import { toPlanTier } from '@/lib/studio/services/catalog';

// GET /api/studio/video-models — BACKLOG 25.8: the AI-clip video models the organisation can pick
// on Create (providers/video-model-catalogue.ts). Scoped to the caller's organisation: its plan
// tier picks the candidate list, and only providers the platform has configured are listed. The
// choice travels as the generate body's preferredProviders.AI_CLIP (services/generate-overrides.ts),
// which the server validates against the same candidate list. No keys, endpoints or secrets;
// prices only for platform staff.
export const GET = withStudioRoute(StudioCapability.ProjectWrite, async ({ tenant, deps }) => {
  const planTier = toPlanTier(tenant.organisation.planTier);
  const models = buildVideoModelCatalogue(deps.registry, planTier);
  return {
    // Generation cost is for platform staff only (operator decision 2026-10-04).
    body: { planTier, models: isCostViewer(tenant) ? models : models.map(withoutCosts) },
    headers: { 'Cache-Control': 'private, max-age=60' },
  };
});
