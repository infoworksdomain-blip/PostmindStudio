import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getMe } from '@/lib/studio/services/me';

// GET /api/studio/me (Phase 18 §3) — the AppShell's context: the signed-in user, the active
// organisation and the others they belong to, the account-state banner and the impersonation
// flag. Every member role has project:read. A user with no organisation gets 403
// no_organisation from the identity provider, and the UI routes them to /welcome.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps, tenant }) => ({
  body: { me: await getMe(deps, tenant) },
}));
