import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { refreshLibraryInput, requestLibraryRefresh } from '@/lib/studio/services/image-library';

// POST /api/studio/image-library/refresh — re-run stock queries for a business (A6.6)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, refreshLibraryInput);
    const result = await requestLibraryRefresh(deps, tenant, input);
    audit('studio.image_library.refresh', { type: 'business', id: input.businessId });
    return { status: 202, body: result };
  },
);
