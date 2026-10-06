import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { anglePatch, publicAngle, updateAngle } from '@/lib/studio/services/angles';
import { parseBusinessId } from '@/lib/studio/services/businesses';

// PATCH /api/studio/businesses/:id/angles/:angleId (22.4) — edit an angle, change its weight,
// retire it ({ retired: true }) or bring it back ({ retired: false }).
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const patch = await parseBody(req, anglePatch);
    const angle = await updateAngle(
      deps.db,
      { organisationId: tenant.organisationId, businessId },
      params.angleId ?? '',
      patch,
      deps.now(),
    );
    audit(
      'studio.angle.update',
      { type: 'content_angle', id: angle.id },
      { businessId, fields: Object.keys(patch) },
    );
    return { body: { angle: publicAngle(angle) } };
  },
);
