import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listNotifications, listNotificationsQuery } from '@/lib/studio/services/notifications';

// GET /api/studio/notifications?unread=true&limit=&cursor= — the caller's in-app notifications
// (their own + organisation-wide), newest first, with the unread count (spec 14.4).
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listNotificationsQuery);
  return { body: await listNotifications(deps.db, tenant, query) };
});
