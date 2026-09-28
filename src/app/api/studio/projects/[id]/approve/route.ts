import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  publishOnApproval,
  scheduledSummary,
  type AutoPublishOutcome,
} from '@/lib/studio/automation/auto-publish';
import { approveWithWorkflow } from '@/lib/studio/services/approval-workflows';
import { approveInput } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/approve — approve renders for publication. Projects with
// publishPolicy AUTO_ON_APPROVAL then publish to their stored targets (the response carries the
// per-target outcome; failures never undo the approval).
// 15.D3: with a multi-step approval workflow, each call approves the current step; the project
// stays READY_FOR_REVIEW (and nothing publishes) until the last step completes. `approval` says
// where the review is: { stepIndex, remainingSteps, stepCount, waitingFor, … }.
export const POST = withStudioRoute(
  StudioCapability.ProjectApprove,
  async ({ req, tenant, deps, params, audit }) => {
    const { note } = await parseBody(req, approveInput);
    const {
      project: approved,
      approval,
      completed,
    } = await approveWithWorkflow(deps.db, tenant, params.id ?? '', note, deps.now());
    const step = approval.workflowId
      ? {
          workflowId: approval.workflowId,
          stepIndex: approval.stepIndex,
          remainingSteps: approval.remainingSteps,
        }
      : undefined;
    audit(
      completed ? 'studio.project.approve' : 'studio.project.approval_step',
      { type: 'video_project', id: approved.id },
      step,
    );
    const autoPublish: AutoPublishOutcome = completed
      ? await publishOnApproval(deps, {
          projectId: approved.id,
          organisationId: tenant.organisationId,
          planTier: tenant.organisation.planTier ?? '',
          trigger: 'human',
        })
      : {
          status: 'skipped',
          reason: `approval step ${approval.stepIndex + 1} of ${approval.stepCount} recorded; waiting for the remaining steps`,
        };
    // `project` is the approval itself (APPROVED once the last step is done); what auto-publish
    // did is in `autoPublish`.
    // 15.A5: SCHEDULED projects list when each target goes live (staggered, spec 9.9).
    return {
      body: {
        project: approved,
        approval,
        autoPublish,
        scheduled: scheduledSummary(autoPublish),
      },
    };
  },
);
