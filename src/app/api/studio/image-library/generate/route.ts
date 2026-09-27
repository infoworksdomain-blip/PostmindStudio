import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { generateImage, generateImageInput } from '@/lib/studio/services/image-library';

// POST /api/studio/image-library/generate — generate on demand and keep it in the library (A6.3)
export const maxDuration = 120;

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, generateImageInput);
    const result = await generateImage(deps.library, tenant, input);
    audit(
      'studio.image_library.generate',
      { type: 'image_library', id: result.image.id },
      {
        businessId: input.businessId,
      },
    );
    return { status: 201, body: result };
  },
);
