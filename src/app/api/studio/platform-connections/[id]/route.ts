import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { disconnect } from '@/lib/studio/services/connections';

// DELETE /api/studio/platform-connections/:id — disconnect (tokens wiped)
export const DELETE = withStudioRoute(
  StudioCapability.ConnectionsManage,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await disconnect(deps.db, tenant.organisationId, id);
    audit('studio.connection.disconnect', { type: 'platform_connection', id });
    return { body: { disconnected: true } };
  },
);
