import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  featureGateFor,
  featuresState,
  setFeature,
  setFeatureInput,
} from '@/lib/studio/services/features';

// GET|PUT /api/studio/admin/features — A12.4 feature flags (BACKLOG 15.D1): turn library,
// overlays, slideshow or image-library off globally or for one organisation. Other processes
// pick the change up within 30 s (flag cache TTL); this one immediately.
export const GET = withStudioRoute(
  StudioCapability.AdminKillSwitchRead,
  async ({ deps, tenant }) => {
    requirePlatformStaff(tenant);
    return { body: await featuresState(deps.db) };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminKillSwitchWrite,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, setFeatureInput);
    const flag = await setFeature(deps.db, input);
    featureGateFor(deps.db).invalidate();
    audit(
      input.enabled ? 'studio.feature.enable' : 'studio.feature.disable',
      { type: 'system_flag', id: flag.key },
      {
        feature: input.feature,
        scope: input.scope,
        organisationId: input.organisationId ?? null,
        reason: input.reason,
      },
    );
    const state = await featuresState(deps.db);
    return { body: { features: state.features, propagationSec: state.propagationSec } };
  },
);
