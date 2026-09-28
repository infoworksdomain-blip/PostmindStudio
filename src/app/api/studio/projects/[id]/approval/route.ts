import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getApprovalStatus } from '@/lib/studio/services/approval-workflows';

// GET /api/studio/projects/:id/approval (15.D3) — where a project is in its approval workflow,
// for the review screen's "Step 1 of 2 — waiting for client_reviewer" indicator. Without a
// workflow, `workflow` is null (single-step approval).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      approval: await getApprovalStatus(
        deps.db,
        tenant.organisationId,
        params.id ?? '',
        deps.now(),
      ),
    },
  }),
);
