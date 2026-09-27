import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  getOnboarding,
  patchOnboarding,
  patchOnboardingInput,
} from '@/lib/studio/services/onboarding';

// GET|PATCH /api/studio/onboarding — the caller's /welcome wizard state (spec 14.5, 13.14).
// Per user and organisation; any member may read and move their own wizard.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => ({
  body: { onboarding: await getOnboarding(deps.db, tenant) },
}));

export const PATCH = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps }) => ({
    body: {
      onboarding: await patchOnboarding(
        deps.db,
        tenant,
        await parseBody(req, patchOnboardingInput),
        deps.now(),
      ),
    },
  }),
);
