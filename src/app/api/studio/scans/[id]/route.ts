import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getScan } from '@/lib/studio/services/scans';

// GET /api/studio/scans/:id — pages crawled, images ingested, errors (A6.8)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { scan: await getScan(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);
