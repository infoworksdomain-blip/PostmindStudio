import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { present, updateCreator, updateCreatorInput } from '@/lib/studio/services/creators';

// BACKLOG 22.3 — PATCH /api/studio/businesses/:id/creators/:creatorId — { name?, voiceTone?,
// isDefault?: true } (rename, voice note, the business's default creator for month plans).
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, updateCreatorInput);
    const creator = await updateCreator(
      deps.db,
      { organisationId: tenant.organisationId, businessId },
      params.creatorId ?? '',
      input,
    );
    audit(
      'studio.creator.update',
      { type: 'creator', id: creator.id },
      { businessId, fields: Object.keys(input) },
    );
    return { body: { creator: await present(deps, creator) } };
  },
);
