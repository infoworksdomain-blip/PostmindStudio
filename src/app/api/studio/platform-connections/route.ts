import { studioModes } from '@/lib/mode';
import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { selectMetaConnect } from '@/lib/studio/core/select';
import { listConnections, oauthAvailability } from '@/lib/studio/services/connections';

// GET /api/studio/platform-connections — the organisation's connected accounts, plus how
// Instagram / Facebook are connected (Phase 18 §2.10):
//   meta.connect    'studio' = Studio's own "Connect" button; 'core' = in PostMind settings
//   meta.configured false while the operator has not set Studio's Meta app (Connect hidden)
//   configured      per OAuth platform (tiktok, youtube, x, linkedin): false while its app is not
//                   set, so the screen explains instead of offering a Connect that fails (20.10)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => {
  const meta = deps.metaConnect ?? selectMetaConnect(deps.modes ?? studioModes());
  return {
    body: {
      data: await listConnections(deps.db, tenant.organisationId),
      meta: { connect: meta.modes.metaConnect, configured: meta.configured },
      configured: oauthAvailability(deps.publishing.oauthConfigured),
    },
  };
});
