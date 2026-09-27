import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createBrandKit,
  createBrandKitInput,
  listBrandKits,
  listBrandKitsQuery,
} from '@/lib/studio/services/brand-kits';

// GET|POST /api/studio/brand-kits (spec 8.5)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { businessId } = parseQuery(req, listBrandKitsQuery);
  return { body: { data: await listBrandKits(deps.db, tenant.organisationId, businessId) } };
});

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const kit = await createBrandKit(deps.db, tenant, await parseBody(req, createBrandKitInput));
    audit('studio.brand_kit.create', { type: 'brand_kit', id: kit.id });
    return { status: 201, body: { brandKit: kit } };
  },
);
