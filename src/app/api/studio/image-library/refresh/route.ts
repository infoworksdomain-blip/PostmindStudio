import { ConfigurationError, NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { refreshLibraryInput, requestLibraryRefresh } from '@/lib/studio/services/image-library';

// POST /api/studio/image-library/refresh — re-run stock queries for a business (A6.6)
// 501 stock_not_configured { reason } while no stock photo provider is set up: the refresh can
// only search stock libraries, so "started" would be a promise nothing keeps.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, refreshLibraryInput);
    try {
      deps.library.stock();
    } catch (err) {
      if (err instanceof ConfigurationError)
        throw new NotImplementedError(
          'Stock photos are not set up yet. Your site photos, uploads and generated images still work.',
          { reason: 'stock_not_configured' },
        );
      throw err;
    }
    const result = await requestLibraryRefresh(deps, tenant, input);
    audit('studio.image_library.refresh', { type: 'business', id: input.businessId });
    return { status: 202, body: result };
  },
  { feature: 'image-library' },
);
