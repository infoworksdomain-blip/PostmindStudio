import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { markAllNotificationsRead } from '@/lib/studio/services/notifications';

// POST /api/studio/notifications/read-all — mark every visible unread notification read.
export const POST = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => {
  return { body: await markAllNotificationsRead(deps.db, tenant, deps.now()) };
});
