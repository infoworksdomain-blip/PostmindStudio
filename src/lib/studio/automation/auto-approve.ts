import type { PipelineDeps } from '../pipeline/deps';
import { projectMetadata } from '../pipeline/project-state';
import type { ProjectJobData } from '../queue/queues';
import { AUTO_APPROVE_ACTOR, mergeMetadata, recordApproval, requiredRoleFor } from './approval';
import { publishOnApproval } from './auto-publish';
import { resolveWorkflowForProject } from '../services/approval-workflows';
import { autoApprovePolicyFor } from '../services/org-policy';
import {
  countHumanApprovedProjects,
  decideAutoApproval,
  type ReviewDecision,
} from './review-policy';

// Runs right after the quality gate moves a project to READY_FOR_REVIEW. Only projects whose
// review policy is AUTO_APPROVE are considered; see review-policy.ts for when they qualify.
// The outcome is written to metadata.review so the Review screen can say "Approved
// automatically" or "Needs review because …".

export interface ReviewRecord {
  decision: 'auto_approved' | 'needs_review';
  code?: string;
  reason?: string;
  /** 17.9: parameters for the reason in the reader's language (review.automation.reasons). */
  params?: Record<string, string | number>;
  humanApprovedCount?: number;
  threshold?: number;
  at: string;
}

async function decide(
  deps: PipelineDeps,
  data: ProjectJobData,
  project: { id: string; createdByUserId: string; metadata: Parameters<typeof projectMetadata>[0] },
): Promise<{ decision: ReviewDecision; humanApprovedCount: number; threshold: number | null }> {
  const metadata = projectMetadata(project.metadata);
  const renderIds = Object.values((metadata.renders as Record<string, string> | undefined) ?? {});
  const [renders, humanApprovedCount] = await Promise.all([
    deps.db.videoRender.findMany({
      where: { id: { in: renderIds }, projectId: project.id },
      select: { targetPlatform: true, qualityCheckState: true, qualityIssues: true },
    }),
    countHumanApprovedProjects(deps.db, {
      organisationId: data.organisationId,
      userId: project.createdByUserId,
      excludeProjectId: project.id,
    }),
  ]);
  // 13.18: the organisation's policy may turn auto-approve off or set its own threshold.
  const orgPolicy = await autoApprovePolicyFor(deps.db, data.organisationId);
  const threshold = orgPolicy.threshold;
  const safety = metadata.scriptSafety as { verdict?: unknown } | undefined;
  const decision = decideAutoApproval({
    planTier: data.planTier,
    threshold,
    humanApprovedCount,
    renders,
    scriptSafetyVerdict: typeof safety?.verdict === 'string' ? safety.verdict : undefined,
    orgAllowsAutoApprove: orgPolicy.allowed,
  });
  return { decision, humanApprovedCount, threshold: threshold.ok ? threshold.value : null };
}

async function approveAutomatically(
  deps: PipelineDeps,
  data: ProjectJobData,
  project: { id: string; reviewPolicy: 'AUTO_APPROVE' },
  humanApprovedCount: number,
): Promise<boolean> {
  const approved = await recordApproval(deps.db, {
    projectId: project.id,
    organisationId: data.organisationId,
    actorId: AUTO_APPROVE_ACTOR,
    requiredRole: requiredRoleFor(project.reviewPolicy),
    note: `Approved automatically: trusted creator (${humanApprovedCount} videos approved by a person) and every quality check passed`,
    now: deps.now(),
    outbox: { planTier: data.planTier, trigger: 'auto' },
  });
  if (!approved) return false;
  deps.audit({
    actorUserId: AUTO_APPROVE_ACTOR,
    organisationId: data.organisationId,
    action: 'studio.project.auto_approve',
    resource: { type: 'video_project', id: project.id },
    metadata: { humanApprovedCount, runId: data.runId },
  });
  return true;
}

export async function autoApproveIfTrusted(
  deps: PipelineDeps,
  data: ProjectJobData,
): Promise<ReviewRecord | null> {
  const log = deps.logger.child({ projectId: data.projectId, organisationId: data.organisationId });
  const project = await deps.db.videoProject.findFirst({
    where: { id: data.projectId, organisationId: data.organisationId, deletedAt: null },
  });
  if (!project || project.state !== 'READY_FOR_REVIEW' || project.reviewPolicy !== 'AUTO_APPROVE')
    return null;
  const at = () => new Date(deps.now()).toISOString();
  let record: ReviewRecord;
  try {
    // 15.D3: auto-approve never bypasses a multi-step approval workflow — when one applies, the
    // project waits for its people (services/approval-workflows.ts).
    const workflow = await resolveWorkflowForProject(deps.db, project);
    const { decision, humanApprovedCount, threshold } = await decide(deps, data, project);
    if (workflow) {
      record = {
        decision: 'needs_review',
        code: 'approval_workflow',
        reason: `Needs review: the “${workflow.name}” approval workflow applies (${workflow.steps.length} step${workflow.steps.length === 1 ? '' : 's'})`,
        params: { workflow: workflow.name, steps: workflow.steps.length },
        humanApprovedCount,
        ...(threshold !== null && { threshold }),
        at: at(),
      };
    } else if (decision.decision === 'needs_review') {
      record = {
        decision: 'needs_review',
        code: decision.code,
        reason: decision.reason,
        ...(decision.params && { params: decision.params }),
        humanApprovedCount,
        ...(threshold !== null && { threshold }),
        at: at(),
      };
    } else {
      const approved = await approveAutomatically(
        deps,
        data,
        { id: project.id, reviewPolicy: 'AUTO_APPROVE' },
        humanApprovedCount,
      );
      if (!approved) {
        log.info('project left review before auto-approval');
        return null;
      }
      record = {
        decision: 'auto_approved',
        humanApprovedCount,
        ...(threshold !== null && { threshold }),
        at: at(),
      };
    }
  } catch (err) {
    // The project stays READY_FOR_REVIEW for a person; the failure is logged and shown.
    log.error({ err }, 'auto-approve evaluation failed; left for human review');
    record = {
      decision: 'needs_review',
      code: 'auto_approve_error',
      reason: 'Needs review: automatic approval could not be evaluated',
      at: at(),
    };
  }
  await mergeMetadata(deps.db, project.id, { review: record });
  log.info({ review: record.decision, code: record.code }, 'review policy applied');
  if (record.decision === 'auto_approved') {
    await publishOnApproval(deps, {
      projectId: project.id,
      organisationId: data.organisationId,
      planTier: data.planTier,
      trigger: 'auto',
    });
  }
  return record;
}
