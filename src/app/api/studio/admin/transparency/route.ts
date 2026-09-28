import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { transparencyQuery, transparencyReport } from '@/lib/studio/services/transparency';

// GET /api/studio/admin/transparency?year=2026 — BACKLOG 15.E4, spec 18.5 annual transparency
// report: content-safety blocks, takedown requests received and platform-mandated removals
// (PostMind staff, studio:admin:moderation). Read-only.
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, tenant, deps }) => {
    requirePlatformStaff(tenant);
    const { year } = parseQuery(req, transparencyQuery);
    return { body: { report: await transparencyReport(deps.db, year, deps.now()) } };
  },
);
