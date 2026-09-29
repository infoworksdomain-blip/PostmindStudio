import { legalReadiness, signupsState } from '@/lib/legal/readiness';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';

// GET /api/studio/admin/legal-readiness (Phase 18 §3) — any PostMind staff member: which legal
// documents are still the repository placeholder, and whether public sign-up is open. The Admin
// Centre shows a warning while anything is outstanding.
export const GET = withStudioRoute(StudioCapability.AdminKillSwitchRead, async ({ tenant }) => {
  requirePlatformStaff(tenant);
  const readiness = await legalReadiness();
  return { body: { readiness, signups: signupsState(readiness) } };
});
