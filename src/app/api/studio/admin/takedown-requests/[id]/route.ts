import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { resolveTakedownInput, resolveTakedownRequest } from '@/lib/studio/services/transparency';

// PATCH /api/studio/admin/takedown-requests/:id { state: ACTIONED|REJECTED, resolutionNote } —
// BACKLOG 15.E4: staff record the outcome once (409 when already resolved).
export const PATCH = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, tenant, deps, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, resolveTakedownInput);
    const request = await resolveTakedownRequest(
      deps.db,
      tenant.userId,
      params.id ?? '',
      input,
      deps.now(),
    );
    audit(
      'studio.takedown_request.resolve',
      { type: 'takedown_request', id: request.id },
      { state: request.state },
    );
    return { body: { request } };
  },
);
