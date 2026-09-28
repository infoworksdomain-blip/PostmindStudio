import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { findRender } from '@/lib/studio/services/renders';
import { thumbnailUrlOf } from '@/lib/studio/services/thumbnails';

// GET /api/studio/renders/:id — render with quality-check details (+ 15.A3 thumbnailUrl, a
// signed URL of the current thumbnail or null)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const { project: _project, ...render } = await findRender(
      deps.db,
      tenant.organisationId,
      params.id ?? '',
    );
    const bucket = deps.thumbnails?.bucket ?? process.env.S3_BUCKET_THUMBNAILS?.trim();
    const thumbnailUrl = bucket
      ? await thumbnailUrlOf({ storage: deps.storage, bucket }, render)
      : null;
    return { body: { render: { ...render, thumbnailUrl } } };
  },
);
