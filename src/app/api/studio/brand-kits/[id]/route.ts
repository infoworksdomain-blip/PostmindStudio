import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  deleteBrandKit,
  getBrandKit,
  updateBrandKit,
  updateBrandKitInput,
} from '@/lib/studio/services/brand-kits';

// GET|PATCH|DELETE /api/studio/brand-kits/:id (spec 8.5)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { brandKit: await getBrandKit(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateBrandKitInput);
    const kit = await updateBrandKit(deps.db, tenant.organisationId, params.id ?? '', input);
    audit(
      'studio.brand_kit.update',
      { type: 'brand_kit', id: kit.id },
      { fields: Object.keys(input) },
    );
    return { body: { brandKit: kit } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await deleteBrandKit(deps.db, tenant.organisationId, id);
    audit('studio.brand_kit.delete', { type: 'brand_kit', id });
    return { body: { deleted: true } };
  },
);
