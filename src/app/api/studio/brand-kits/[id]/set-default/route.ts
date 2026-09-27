import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { setDefaultBrandKit } from '@/lib/studio/services/brand-kits';

// POST /api/studio/brand-kits/:id/set-default (spec 8.5)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const kit = await setDefaultBrandKit(deps.db, tenant.organisationId, params.id ?? '');
    audit('studio.brand_kit.set_default', { type: 'brand_kit', id: kit.id });
    return { body: { brandKit: kit } };
  },
);
