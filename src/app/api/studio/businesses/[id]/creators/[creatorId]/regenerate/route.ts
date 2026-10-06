import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import {
  creatorDepsFrom,
  present,
  regenerateCreator,
  regenerateCreatorInput,
} from '@/lib/studio/services/creators';

// BACKLOG 22.3 — POST /api/studio/businesses/:id/creators/:creatorId/regenerate —
// { instructions? }: a new generated portrait (same route, budgets, caps and kill switch as the
// first). Projects made earlier keep the portrait they pinned.
export const maxDuration = 120;

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, regenerateCreatorInput);
    const result = await regenerateCreator(
      creatorDepsFrom(deps),
      tenant,
      businessId,
      params.creatorId ?? '',
      input,
    );
    audit(
      'studio.creator.regenerate',
      { type: 'creator', id: result.creator.id },
      {
        businessId,
        portraitId: result.creator.portraitId,
        withInstructions: Boolean(input.instructions),
        portraitError: result.portraitError,
      },
    );
    return { body: { creator: await present(deps, result.creator) } };
  },
);
