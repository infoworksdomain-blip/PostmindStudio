import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { featureGateFor } from '@/lib/studio/services/features';
import { listMedia, listMediaQuery } from '@/lib/studio/services/media';

// GET /api/studio/media?type=all|video|image|upload&businessId=&cursor=&limit= — BACKLOG 25.10
// "My media": the organisation's finished renders, uploaded videos and library images, newest
// first (read-only; services/media.ts). Images only while the image-library feature is on.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listMediaQuery);
  const images =
    query.type === 'all' || query.type === 'image'
      ? await featureGateFor(deps.db).status('image-library', tenant.organisationId)
      : { enabled: false };
  return {
    body: await listMedia(
      {
        db: deps.db,
        storage: deps.storage,
        thumbnailBucket:
          deps.thumbnails?.bucket ?? process.env.S3_BUCKET_THUMBNAILS?.trim() ?? null,
        imagesEnabled: images.enabled,
      },
      tenant.organisationId,
      query,
    ),
  };
});
