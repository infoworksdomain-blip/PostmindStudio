import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import {
  createCreator,
  createCreatorInput,
  creatorDepsFrom,
  listCreators,
  listCreatorsQuery,
  present,
} from '@/lib/studio/services/creators';

// BACKLOG 22.3 — reusable AI creators of a business.
// GET  /api/studio/businesses/:id/creators[?includeRetired=true] — READY first, most used first
// POST /api/studio/businesses/:id/creators — { name, gender, ageRange, setting, appearance?,
//      voiceTone? }: a new creator and its generated portrait (the IMAGE_STILL route; DRAFT with
//      portraitError when no portrait could be made). At most 20 per business.
export const maxDuration = 120;

export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps, params }) => {
    const { includeRetired } = parseQuery(req, listCreatorsQuery);
    const data = await listCreators(
      deps,
      { organisationId: tenant.organisationId, businessId: parseBusinessId(params.id) },
      { includeRetired: includeRetired === 'true' },
    );
    return { body: { data } };
  },
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, createCreatorInput);
    const result = await createCreator(creatorDepsFrom(deps), tenant, businessId, input);
    audit(
      'studio.creator.create',
      { type: 'creator', id: result.creator.id },
      {
        businessId,
        source: 'GENERATED',
        status: result.creator.status,
        portraitError: result.portraitError,
      },
    );
    return { status: 201, body: { creator: await present(deps, result.creator) } };
  },
);
