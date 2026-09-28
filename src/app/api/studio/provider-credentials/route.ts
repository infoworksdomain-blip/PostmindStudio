import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { BYOC_PROVIDERS } from '@/lib/studio/providers/byoc-providers';
import { byocAvailability, listCredentials } from '@/lib/studio/services/provider-credentials';

// P1 BYOC (operator decision 2026-09-28; spec 6.6 / 12.6). GET /api/studio/provider-credentials
// → { enabled, reason?, providers, credentials }. Never returns key material (hint = last 4).
// When STUDIO_BYOC_ENABLED is off or the plan is not Enterprise: 200 { enabled: false, reason:
// 'disabled' | 'plan_tier', credentials: [] }; the mutations answer 403 feature_disabled /
// plan_tier. Managing provider keys uses the connections capability (external credentials).
export const GET = withStudioRoute(StudioCapability.ConnectionsManage, async ({ tenant, deps }) => {
  const availability = byocAvailability(tenant);
  const providers = BYOC_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    twoPart: 'secondaryKeyLabel' in p,
  }));
  if (!availability.enabled) return { body: { ...availability, providers, credentials: [] } };
  return {
    body: {
      enabled: true,
      providers,
      credentials: await listCredentials(deps.db, tenant.organisationId),
    },
  };
});
