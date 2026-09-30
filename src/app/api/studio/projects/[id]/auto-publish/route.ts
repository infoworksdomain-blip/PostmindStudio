import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { latestOutbox, publicOutboxRow, readScheduleIssue } from '@/lib/studio/automation/outbox';
import { findProject } from '@/lib/studio/services/projects';

// GET /api/studio/projects/:id/auto-publish — BACKLOG 13.21: the auto-publish outbox of the
// project's latest approval, one row per target (PENDING / SENDING / SENT / FAILED, attempts,
// last error, next retry). Empty when the project was never approved with AUTO_ON_APPROVAL.
// 20.3: scheduleIssue = why an approved SCHEDULED project got no drip slot (null otherwise).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const project = await findProject(deps.db, tenant.organisationId, params.id ?? '');
    const rows = await latestOutbox(deps.db, project.id);
    return {
      body: {
        projectId: project.id,
        publishPolicy: project.publishPolicy,
        outbox: rows.map(publicOutboxRow),
        scheduleIssue: readScheduleIssue(project.metadata),
      },
    };
  },
);
