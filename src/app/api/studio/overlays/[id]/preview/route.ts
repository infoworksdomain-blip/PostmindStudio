import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { previewOverlay } from '@/lib/studio/overlays/preview';
import { toPlanTier } from '@/lib/studio/services/catalog';

// POST /api/studio/overlays/:id/preview — signed URL of a short preview render (A4.8)
export const maxDuration = 120;

export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      preview: await previewOverlay(
        {
          db: deps.db,
          storage: deps.library.storage,
          bucket: deps.library.bucket,
          providers: deps.library.providers,
          fetchImpl: deps.library.fetchImpl,
          fontsBaseUrl: deps.fontsBaseUrl,
        },
        {
          organisationId: tenant.organisationId,
          planTier: toPlanTier(tenant.organisation.planTier),
        },
        params.id ?? '',
      ),
    },
  }),
);
