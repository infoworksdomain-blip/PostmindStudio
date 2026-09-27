import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { markNotificationRead } from '@/lib/studio/services/notifications';

// POST /api/studio/notifications/:id/read — mark one notification read (idempotent).
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const notification = await markNotificationRead(deps.db, tenant, params.id ?? '', deps.now());
    return { body: { notification } };
  },
);
