import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { angleInput, createAngle, listAngles, publicAngle } from '@/lib/studio/services/angles';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { MAX_ANGLES } from '@/lib/studio/blitz/constants';

// /api/studio/businesses/:id/angles (22.4) — the business's content angles (title, description,
// target audience, weight; at most 100 live). GET ?retired=1 includes retired ones.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps, params }) => {
    const businessId = parseBusinessId(params.id);
    const includeRetired = new URL(req.url).searchParams.get('retired') === '1';
    const angles = await listAngles(
      deps.db,
      { organisationId: tenant.organisationId, businessId },
      { includeRetired },
    );
    return { body: { angles: angles.map(publicAngle), max: MAX_ANGLES } };
  },
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, angleInput);
    const angle = await createAngle(
      deps.db,
      { organisationId: tenant.organisationId, businessId },
      tenant.userId,
      input,
    );
    audit('studio.angle.create', { type: 'content_angle', id: angle.id }, { businessId });
    return { status: 201, body: { angle: publicAngle(angle) } };
  },
);
