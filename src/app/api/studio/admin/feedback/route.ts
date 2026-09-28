import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listFeedback, listFeedbackQuery } from '@/lib/studio/services/feedback';

// BACKLOG 14.11 — staff list of in-app feedback, newest first.
// GET /api/studio/admin/feedback?kind&organisationId&cohort&since&limit&cursor
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    return { body: await listFeedback(deps.db, parseQuery(req, listFeedbackQuery)) };
  },
);
