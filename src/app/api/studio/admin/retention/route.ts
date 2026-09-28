import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { previewRetention } from '@/lib/studio/services/retention';

// GET /api/studio/admin/retention — BACKLOG 15.E8: dry run of the daily spec 7.15 retention
// sweep (what each rule would delete now, with its cutoff). PostMind staff,
// studio:admin:moderation. Deletes nothing.
export const GET = withStudioRoute(StudioCapability.AdminModeration, async ({ tenant, deps }) => {
  requirePlatformStaff(tenant);
  return { body: { rules: await previewRetention(deps.db, deps.now()), dryRun: true } };
});
