import { studioModes } from '@/lib/mode';
import { StudioCapability } from '@/lib/rbac';
import { assertLocalBusinesses } from '@/lib/studio/core/select';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { purgeBusiness } from '@/lib/studio/services/business-purge';
import {
  markBusinessDeleted,
  parseBusinessId,
  updateBusiness,
  updateBusinessInput,
} from '@/lib/studio/services/businesses';

// Phase 18 §2.11 (standalone businesses). 404 for a business of another organisation.
//   PATCH  /api/studio/businesses/:id { name?, domain? | null } → 200 { business }
//   DELETE /api/studio/businesses/:id → 202 { purge }: the business is soft-deleted and its data
//          goes through the existing purge (projects stopped, scheduled posts cancelled, style
//          memories and business-scoped tokens wiped; hard delete after the 30-day grace).

export const PATCH = withStudioRoute(
  StudioCapability.BusinessManage,
  async ({ req, deps, tenant, params, audit }) => {
    assertLocalBusinesses(deps.modes ?? studioModes());
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, updateBusinessInput);
    const business = await updateBusiness(deps.db, tenant.organisationId, businessId, input);
    audit(
      'studio.business.update',
      { type: 'business', id: businessId },
      {
        fields: Object.keys(input),
      },
    );
    return { body: { business } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.BusinessManage,
  async ({ deps, tenant, params, audit }) => {
    assertLocalBusinesses(deps.modes ?? studioModes());
    const businessId = parseBusinessId(params.id);
    await markBusinessDeleted(deps.db, tenant.organisationId, businessId, new Date(deps.now()));
    const purge = await purgeBusiness(deps, { organisationId: tenant.organisationId, businessId });
    audit(
      'studio.business.delete',
      { type: 'business', id: businessId },
      {
        projectsDeleted: purge.projectsDeleted,
        publicationsCancelled: purge.publicationsCancelled,
        channelsWiped: purge.channelsWiped,
        graceUntil: purge.graceUntil,
      },
    );
    return { status: 202, body: { purge } };
  },
);
