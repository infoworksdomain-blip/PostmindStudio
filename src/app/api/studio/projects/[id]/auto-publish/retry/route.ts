import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import {
  recordOutboxResult,
  createTargetSender,
  retrySchedule,
} from '@/lib/studio/automation/auto-publish';
import { dispatchOutbox, requeueFailed } from '@/lib/studio/automation/outbox';
import { findProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/auto-publish/retry — BACKLOG 13.21: re-arm the FAILED outbox rows
// of the latest approval (attempts reset) and send them now. 202 { requeued, scheduled,
// unscheduled }; rows that fail again go back to the outbox's retry schedule. 20.3: an approved
// SCHEDULED project that got no drip slot is planned again against the current posting times
// (`scheduled` rows written, or `unscheduled` says why there is still no slot). Needs
// studio:publication:write, like publishing.
export const POST = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ tenant, deps, params, audit }) => {
    const project = await findProject(deps.db, tenant.organisationId, params.id ?? '');
    const requeued = await requeueFailed(deps, project.id);
    if (requeued > 0) {
      await dispatchOutbox(deps, createTargetSender(deps), { projectId: project.id });
      await recordOutboxResult(deps, project.id, 'human');
    }
    const schedule =
      requeued > 0
        ? { count: 0, unscheduled: null }
        : await retrySchedule(deps, project, tenant.organisation.planTier ?? '');
    audit(
      'studio.project.auto_publish_retry',
      { type: 'video_project', id: project.id },
      { requeued, scheduled: schedule.count, unscheduled: schedule.unscheduled },
    );
    return {
      status: 202,
      body: { requeued, scheduled: schedule.count, unscheduled: schedule.unscheduled },
    };
  },
);
