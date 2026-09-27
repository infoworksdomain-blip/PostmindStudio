import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { searchImages, searchImagesInput } from '@/lib/studio/services/image-library';

// POST /api/studio/image-library/search — semantic search (pgvector cosine) (A6.8)
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps }) => ({
    body: await searchImages(deps.library, tenant, await parseBody(req, searchImagesInput)),
  }),
);
