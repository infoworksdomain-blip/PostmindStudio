import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { pendingCoreBusinessDirectory } from '@/lib/studio/core/business-directory';

// GET /api/studio/businesses (BACKLOG 13.34) — the active organisation's businesses from PostMind
// Core: 200 { data: [{ id, name, domain? }] }. Core has no list-businesses endpoint yet, so this
// answers 501 not_implemented "waiting for Core list-businesses (…)" and never invents a list.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps, tenant }) => {
  const directory = deps.core?.businesses ?? pendingCoreBusinessDirectory;
  const businesses = await directory.listBusinesses(tenant.organisationId);
  return {
    body: {
      data: businesses.map((b) => ({
        id: b.id,
        name: b.name,
        ...(b.domain && { domain: b.domain }),
      })),
    },
  };
});
