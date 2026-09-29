import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { emailDeliveryFor } from '@/lib/studio/notifications/email-delivery';
import {
  getPreferences,
  preferencesPatchInput,
  updatePreferences,
} from '@/lib/studio/notifications/preferences';

// BACKLOG 13.24 — the caller's notification preferences, per kind: { inApp, email }.
// GET → every kind (defaults: in-app on, email off). PATCH { <kind>: { inApp?, email? } } → the
// updated map. Own preferences only; any member may set them. emailDelivery (Phase 18 §2.8):
// "active" when Studio sends email (Resend), "suppressed" when the caller's address bounced or
// complained (the UI says "we can't email you"), "pending_setup" with no sender (core mode).

export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => ({
  body: {
    preferences: await getPreferences(deps.db, tenant),
    emailDelivery: await emailDeliveryFor(deps, tenant.userId),
  },
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
    return { body: { preferences, emailDelivery: await emailDeliveryFor(deps, tenant.userId) } };
  },
);
