import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  getPreferences,
  preferencesPatchInput,
  updatePreferences,
} from '@/lib/studio/notifications/preferences';

// BACKLOG 13.24 — the caller's notification preferences, per kind: { inApp, email }.
// GET → every kind (defaults: in-app on, email off). PATCH { <kind>: { inApp?, email? } } → the
// updated map. Email choices are stored; delivery waits for an email channel (13.33), so the
// response says emailDelivery "pending_setup". Own preferences only; any member may set them.
const EMAIL_DELIVERY = 'pending_setup' as const;

export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => ({
  body: { preferences: await getPreferences(deps.db, tenant), emailDelivery: EMAIL_DELIVERY },
}));

export const PATCH = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps, audit }) => {
    const patch = await parseBody(req, preferencesPatchInput);
    const preferences = await updatePreferences(deps.db, tenant, patch);
    audit(
      'studio.notification_preferences.update',
      { type: 'notification_preferences', id: tenant.userId },
      { kinds: Object.keys(patch) },
    );
    return { body: { preferences, emailDelivery: EMAIL_DELIVERY } };
  },
);
