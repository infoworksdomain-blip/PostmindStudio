import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { deleteImage, getImage } from '@/lib/studio/services/image-library';

// GET|DELETE /api/studio/image-library/:id
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { image: await getImage(deps, tenant.organisationId, params.id ?? '') },
  }),
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await deleteImage(deps.library, tenant.organisationId, id);
    audit('studio.image_library.delete', { type: 'image_library', id });
    return { body: { deleted: true } };
  },
);
