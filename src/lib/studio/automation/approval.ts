import type { Prisma, PrismaClient, ReviewPolicy } from '@prisma/client';
import { ForbiddenError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { writeOutboxRows } from './outbox';

// One way to approve a project (spec 5.9 "user approval checkpoint"), shared by the human route
// (POST /projects/:id/approve) and the automatic path (automation/auto-approve.ts): the project
// moves READY_FOR_REVIEW → APPROVED and an approval_tasks row records who approved it.

/** resolvedByUserId of approvals made by the system. Human approvals carry a Core user id. */
export const SYSTEM_ACTOR_PREFIX = 'system:';
export const AUTO_APPROVE_ACTOR = 'system:auto-approve';
export const AUTO_PUBLISH_ACTOR = 'system:auto-publish';

/**
 * REQUIRE_APPROVAL_FROM_ROLE: the spec names the policy but not the role. When a 15.D3 approval
 * workflow applies to the project, its step roles decide instead (services/approval-workflows.ts).
 * Without one — DECISION: the approver must hold the
 * organisation's `owner` or `admin` membership role from PostMind Core, on top of the
 * studio:project:approve capability every approval needs.
 */
export const APPROVER_ROLES = ['owner', 'admin'] as const;

export function isSystemActor(userId: string | null | undefined): boolean {
  return Boolean(userId?.startsWith(SYSTEM_ACTOR_PREFIX));
}

export function requiredRoleFor(policy: ReviewPolicy): string {
  return policy === 'REQUIRE_APPROVAL_FROM_ROLE' ? APPROVER_ROLES.join('|') : 'reviewer';
}

export function assertMayApprove(
  tenant: Pick<TenantContext, 'organisationId' | 'memberships'>,
  project: { reviewPolicy: ReviewPolicy },
): void {
  if (project.reviewPolicy !== 'REQUIRE_APPROVAL_FROM_ROLE') return;
  const roles = tenant.memberships
    .filter((m) => m.organisationId === tenant.organisationId)
    .map((m) => m.role.trim().toLowerCase());
  if (!roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r))) {
    throw new ForbiddenError(
      `This project needs approval from an organisation ${APPROVER_ROLES.join(' or ')}`,
      { requiredRoles: [...APPROVER_ROLES] },
    );
  }
}

export interface ApprovalInput {
  projectId: string;
  organisationId: string;
  actorId: string;
  requiredRole: string;
  note: string | null;
  now: number;
  /** 13.21: write the auto-publish outbox rows in the same transaction (AUTO_ON_APPROVAL). */
  outbox?: { planTier: string; trigger: 'human' | 'auto' };
  /** 15.D3: the approval workflow and step this final approval completes (default: none, 0). */
  workflowId?: string | null;
  stepIndex?: number;
}

/**
 * The transactional body of recordApproval, for callers that already hold a transaction
 * (15.D3 services/approval-workflows.ts completes the last workflow step with it).
 * Returns the approval_tasks id, or null (recording nothing) when the project was no longer
 * awaiting review.
 */
export async function recordApprovalTx(
  tx: Prisma.TransactionClient,
  input: ApprovalInput,
): Promise<string | null> {
  const moved = await tx.videoProject.updateMany({
    where: {
      id: input.projectId,
      organisationId: input.organisationId,
      state: 'READY_FOR_REVIEW',
    },
    data: { state: 'APPROVED' },
  });
  if (moved.count === 0) return null;
  const task = await tx.approvalTask.create({
    data: {
      projectId: input.projectId,
      workflowId: input.workflowId ?? null,
      stepIndex: input.stepIndex ?? 0,
      requiredRole: input.requiredRole,
      state: 'APPROVED',
      resolvedByUserId: input.actorId,
      note: input.note,
      resolvedAt: new Date(input.now),
    },
  });
  if (input.outbox) {
    await writeOutboxRows(tx, {
      projectId: input.projectId,
      organisationId: input.organisationId,
      approvalTaskId: task.id,
      planTier: input.outbox.planTier,
      trigger: input.outbox.trigger,
      now: input.now,
    });
  }
  return task.id;
}

/**
 * Compare-and-set READY_FOR_REVIEW → APPROVED plus the approval row (and, 13.21, the auto-publish
 * outbox rows), in one transaction.
 * Returns false (and records nothing) when the project was no longer awaiting review.
 */
export async function recordApproval(db: PrismaClient, input: ApprovalInput): Promise<boolean> {
  return (await db.$transaction((tx) => recordApprovalTx(tx, input))) !== null;
}

/**
 * Merge keys into project.metadata atomically (JSONB `||`) regardless of run: approval-time
 * bookkeeping (review decision, auto-publish results) belongs to the project, not to a run.
 */
export async function mergeMetadata(
  db: Pick<PrismaClient, '$executeRaw'>,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
        "updatedAt" = now()
    WHERE "id" = ${projectId}`;
}
