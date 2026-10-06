import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { present, retireCreator } from '@/lib/studio/services/creators';

// BACKLOG 22.3 — POST /api/studio/businesses/:id/creators/:creatorId/retire — no longer offered for
// new videos (and no longer the month-plan default); projects that used it keep its portrait.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const creator = await retireCreator(
      deps.db,
      tenant,
      businessId,
      params.creatorId ?? '',
      deps.now(),
    );
    audit('studio.creator.retire', { type: 'creator', id: creator.id }, { businessId });
    return { body: { creator: await present(deps, creator) } };
  },
);
