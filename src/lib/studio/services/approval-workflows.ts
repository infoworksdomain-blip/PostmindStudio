import type { ApprovalWorkflow, Prisma, PrismaClient, VideoProject } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { ROLE_CAPABILITIES } from '../../identity/role-capabilities';
import { studioModes } from '../../mode';
import { StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import {
  APPROVER_ROLES,
  assertMayApprove,
  mergeMetadata,
  recordApproval,
  recordApprovalTx,
  requiredRoleFor,
} from '../automation/approval';
import {
  activeSnapshot,
  decideStepApproval,
  explicitWorkflowId,
  matchWorkflow,
  memberRoles,
  newSnapshot,
  projectFacts,
  readSnapshot,
  SNAPSHOT_KEY,
  stepProgress,
  unapprovableStepRoles,
  workflowAppliesTo,
  workflowSteps,
  type WorkflowAppliesTo,
  type WorkflowSnapshot,
  type WorkflowStep,
  type WorkflowView,
} from './approval-workflow-steps';
import { PLATFORMS } from './catalog';
import { assertTierGate } from './tier-gates';

// 15.D3 — multi-step approval workflows (spec 7.13, 3.3). An organisation defines ordered steps
// ([{ role, minApprovers }]) and which projects they apply to (businessIds / platforms / tags).
// Approving a project with a matching workflow records one APPROVED approval_tasks row per
// approver against the current step; the project stays READY_FOR_REVIEW until the last step is
// complete, and only then does the existing recordApproval compare-and-set (→ APPROVED + the
// auto-publish outbox) run. Projects with no matching workflow keep the single-step approval.
//
// Who may edit workflows: studio:project:approve (routes) plus an organisation owner/admin
// membership (APPROVER_ROLES) — a client_reviewer who can approve cannot loosen the process.
// Everyone with studio:project:read may list them (the 15.C4 create-screen picker).

type Db = PrismaClient;

/** Spec 7.2 sizes approval_workflows at 0–20 per organisation; refuse beyond a generous cap. */
export const MAX_WORKFLOWS_PER_ORG = 50;

const name = z.string().trim().min(1).max(120);

export const createWorkflowInput = z
  .object({
    name,
    steps: workflowSteps,
    appliesTo: workflowAppliesTo.default({ platforms: [], businessIds: [], tags: [] }),
  })
  .strict();

export const updateWorkflowInput = z
  .object({ name, steps: workflowSteps, appliesTo: workflowAppliesTo })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listWorkflowsQuery = z.object({
  /** With businessId: also say which workflow a project for it would get (`matched`). */
  businessId: z.string().trim().min(1).max(128).optional(),
  /** Comma-separated target platforms for the `matched` preview. */
  platforms: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v ? v.split(',').map((p) => p.trim()) : []))
    .pipe(z.array(z.enum(PLATFORMS))),
});

export function toWorkflowView(row: ApprovalWorkflow): WorkflowView {
  // Rows are written through the zod schemas above; a malformed row (hand-edited) is treated
  // as matching nothing rather than breaking every approval in the organisation.
  const steps = workflowSteps.safeParse(row.steps);
  const appliesTo = workflowAppliesTo.safeParse(row.appliesTo);
  return {
    id: row.id,
    organisationId: row.organisationId,
    name: row.name,
    steps: steps.success ? steps.data : [],
    appliesTo: appliesTo.success
      ? appliesTo.data
      : { platforms: [], businessIds: ['(invalid appliesTo)'], tags: [] },
    createdAt: row.createdAt,
  };
}

export function assertMayManageWorkflows(tenant: TenantContext): void {
  const roles = memberRoles(tenant);
  if (!roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r))) {
    throw new ForbiddenError(
      `Only an organisation ${APPROVER_ROLES.join(' or ')} can change approval workflows`,
      { requiredRoles: [...APPROVER_ROLES] },
    );
  }
}

/**
 * Standalone mode: every step must name an organisation role that can approve (owner, admin or
 * publisher). Core mode keeps free-form roles (client_reviewer, legal, ...), which Core assigns.
 */
export function assertStepRolesCanApprove(
  steps: ReadonlyArray<{ role: string }>,
  identity: 'standalone' | 'core' = studioModes().identity,
): void {
  if (identity !== 'standalone') return;
  const approvers = Object.entries(ROLE_CAPABILITIES)
    .filter(([, caps]) => caps.includes(StudioCapability.ProjectApprove))
    .map(([role]) => role);
  const bad = unapprovableStepRoles(steps, approvers);
  if (bad.length === 0) return;
  throw new ValidationError(
    `No member can hold the role ${bad.join(', ')}; use ${approvers.join(', ')}`,
    { roles: bad, allowedRoles: approvers },
  );
}

async function orgWorkflows(db: Pick<Db, 'approvalWorkflow'>, organisationId: string) {
  const rows = await db.approvalWorkflow.findMany({
    where: { organisationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_WORKFLOWS_PER_ORG,
  });
  return rows.map(toWorkflowView).filter((w) => w.steps.length > 0);
}

export async function listWorkflows(
  db: Db,
  organisationId: string,
  query: z.infer<typeof listWorkflowsQuery> = { platforms: [] },
) {
  const data = await orgWorkflows(db, organisationId);
  if (!query.businessId) return { data };
  const matched = matchWorkflow(data, {
    businessId: query.businessId,
    platforms: query.platforms,
    tags: [],
  });
  return { data, matched: matched?.id ?? null };
}

export async function getWorkflow(db: Db, organisationId: string, id: string) {
  const row = await db.approvalWorkflow.findFirst({ where: { id, organisationId } });
  if (!row) throw new NotFoundError('Approval workflow not found');
  return toWorkflowView(row);
}

export async function createWorkflow(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof createWorkflowInput>,
) {
  assertMayManageWorkflows(tenant);
  assertStepRolesCanApprove(input.steps);
  // Phase 18 §P.1 (open question 6): multi-step workflows are STANDARD and above; a single
  // approval step stays available on BASIC, and workflows created earlier keep working.
  if (input.steps.length > 1) assertTierGate(tenant, 'approval.workflows');
  const count = await db.approvalWorkflow.count({
    where: { organisationId: tenant.organisationId },
  });
  if (count >= MAX_WORKFLOWS_PER_ORG)
    throw new ConflictError(`An organisation can have at most ${MAX_WORKFLOWS_PER_ORG} workflows`);
  const row = await db.approvalWorkflow.create({
    data: {
      organisationId: tenant.organisationId,
      name: input.name,
      steps: input.steps as Prisma.InputJsonValue,
      appliesTo: input.appliesTo as Prisma.InputJsonValue,
    },
  });
  return toWorkflowView(row);
}

/**
 * Edits apply to review rounds that start afterwards: a project already part-way through a
 * workflow keeps the steps it started with (metadata.approvalWorkflow snapshot).
 */
export async function updateWorkflow(
  db: Db,
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof updateWorkflowInput>,
) {
  assertMayManageWorkflows(tenant);
  if (input.steps) assertStepRolesCanApprove(input.steps);
  await getWorkflow(db, tenant.organisationId, id);
  const data: Prisma.ApprovalWorkflowUpdateManyMutationInput = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.steps !== undefined && { steps: input.steps as Prisma.InputJsonValue }),
    ...(input.appliesTo !== undefined && {
      appliesTo: input.appliesTo as Prisma.InputJsonValue,
    }),
  };
  const updated = await db.approvalWorkflow.updateMany({
    where: { id, organisationId: tenant.organisationId },
    data,
  });
  if (updated.count === 0) throw new NotFoundError('Approval workflow not found');
  return getWorkflow(db, tenant.organisationId, id);
}

/** Hard delete (the table has no deletedAt). In-flight review rounds keep their snapshot. */
export async function deleteWorkflow(db: Db, tenant: TenantContext, id: string) {
  assertMayManageWorkflows(tenant);
  const deleted = await db.approvalWorkflow.deleteMany({
    where: { id, organisationId: tenant.organisationId },
  });
  if (deleted.count === 0) throw new NotFoundError('Approval workflow not found');
}

// ------------------------------------------------------------------ project resolution

type ProjectRow = Pick<
  VideoProject,
  'id' | 'organisationId' | 'businessId' | 'targetFormats' | 'metadata'
>;

/**
 * The workflow for a project right now: an explicitly chosen one (metadata.approvalWorkflowId,
 * the 15.C4 picker) when it still exists, else the best appliesTo match, else null.
 */
export async function resolveWorkflowForProject(
  db: Pick<Db, 'approvalWorkflow'>,
  project: ProjectRow,
): Promise<WorkflowView | null> {
  const workflows = await orgWorkflows(db, project.organisationId);
  const explicit = explicitWorkflowId(project.metadata);
  const chosen = explicit ? workflows.find((w) => w.id === explicit) : undefined;
  return chosen ?? matchWorkflow(workflows, projectFacts(project));
}

export interface ApprovalProgress {
  workflowId: string | null;
  workflowName: string | null;
  /** The step this approval was recorded against (0 without a workflow). */
  stepIndex: number;
  stepCount: number;
  remainingSteps: number;
  /** The step now waiting (null once approved). */
  nextStepIndex: number | null;
  waitingFor: { role: string; minApprovers: number; approvals: number } | null;
}

const SINGLE_STEP: ApprovalProgress = {
  workflowId: null,
  workflowName: null,
  stepIndex: 0,
  stepCount: 1,
  remainingSteps: 0,
  nextStepIndex: null,
  waitingFor: null,
};

async function loadProject(db: Pick<Db, 'videoProject'>, organisationId: string, id: string) {
  const project = await db.videoProject.findFirst({
    where: { id, organisationId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');
  return project;
}

function assertReviewable(state: string) {
  if (state !== 'READY_FOR_REVIEW') {
    throw new ConflictError(`Only READY_FOR_REVIEW projects can be approved (project is ${state})`);
  }
}

function waitingFor(steps: WorkflowStep[], snapshot: Pick<WorkflowSnapshot, 'approvals'>) {
  const progress = stepProgress(steps, snapshot.approvals);
  const step = steps[progress.currentStep];
  return step
    ? { role: step.role, minApprovers: step.minApprovers, approvals: progress.approvalsInStep }
    : null;
}

async function writeSnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  snapshot: WorkflowSnapshot,
) {
  await mergeMetadata(tx, projectId, { [SNAPSHOT_KEY]: snapshot });
}

async function lockProject(tx: Prisma.TransactionClient, organisationId: string, id: string) {
  // Serialise approvals of one project so two approvers of a minApprovers=2 step cannot both
  // count one approval (or both complete the workflow).
  await tx.$queryRaw`SELECT "id" FROM "studio"."video_projects" WHERE "id" = ${id} FOR UPDATE`;
  const project = await tx.videoProject.findFirst({
    where: { id, organisationId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');
  if (project.state !== 'READY_FOR_REVIEW')
    throw new ConflictError('Project changed concurrently; reload and retry');
  return project;
}

/**
 * Human approval (spec 5.9 + 7.13). Returns the project (unchanged shape: callers such as the
 * approve route and 15.A5 scheduling read `project.state`), the step progress, and whether this
 * approval completed the review (only then is the project APPROVED and the outbox written).
 */
export async function approveWithWorkflow(
  db: Db,
  tenant: TenantContext,
  id: string,
  note: string | undefined,
  now: number,
): Promise<{ project: VideoProject; approval: ApprovalProgress; completed: boolean }> {
  const project = await loadProject(db, tenant.organisationId, id);
  assertReviewable(project.state);
  const inProgress = activeSnapshot(project.metadata);
  const workflow = inProgress ? null : await resolveWorkflowForProject(db, project);

  if (!inProgress && !workflow) {
    assertMayApprove(tenant, project);
    const approved = await recordApproval(db, {
      projectId: id,
      organisationId: tenant.organisationId,
      actorId: tenant.userId,
      requiredRole: requiredRoleFor(project.reviewPolicy),
      note: note ?? null,
      now,
      outbox: { planTier: tenant.organisation.planTier ?? '', trigger: 'human' },
    });
    if (!approved) throw new ConflictError('Project changed concurrently; reload and retry');
    return {
      project: await loadProject(db, tenant.organisationId, id),
      approval: SINGLE_STEP,
      completed: true,
    };
  }

  const outcome = await db.$transaction(async (tx) => {
    const locked = await lockProject(tx, tenant.organisationId, id);
    const snapshot =
      activeSnapshot(locked.metadata) ??
      (workflow ? newSnapshot(workflow, locked.metadata, now) : null);
    if (!snapshot) throw new ConflictError('Project changed concurrently; reload and retry');
    const decision = decideStepApproval(snapshot.steps, snapshot.approvals, {
      userId: tenant.userId,
      roles: memberRoles(tenant),
    });
    const at = new Date(now);
    let taskId: string | null;
    if (decision.completesWorkflow) {
      taskId = await recordApprovalTx(tx, {
        projectId: id,
        organisationId: tenant.organisationId,
        actorId: tenant.userId,
        requiredRole: decision.requiredRole,
        note: note ?? null,
        now,
        outbox: { planTier: tenant.organisation.planTier ?? '', trigger: 'human' },
        workflowId: snapshot.workflowId,
        stepIndex: decision.stepIndex,
      });
      if (!taskId) throw new ConflictError('Project changed concurrently; reload and retry');
    } else {
      const task = await tx.approvalTask.create({
        data: {
          projectId: id,
          workflowId: snapshot.workflowId,
          stepIndex: decision.stepIndex,
          requiredRole: decision.requiredRole,
          state: 'APPROVED',
          resolvedByUserId: tenant.userId,
          note: note ?? null,
          createdAt: at,
          resolvedAt: at,
        },
      });
      taskId = task.id;
    }
    const next: WorkflowSnapshot = {
      ...snapshot,
      approvals: [
        ...snapshot.approvals,
        {
          stepIndex: decision.stepIndex,
          userId: tenant.userId,
          taskId,
          at: at.toISOString(),
        },
      ],
      ...(decision.completesWorkflow && {
        closedAt: at.toISOString(),
        outcome: 'approved' as const,
      }),
    };
    await writeSnapshot(tx, id, next);
    return { snapshot: next, decision };
  });

  const { snapshot, decision } = outcome;
  return {
    project: await loadProject(db, tenant.organisationId, id),
    approval: {
      workflowId: snapshot.workflowId,
      workflowName: snapshot.name,
      stepIndex: decision.stepIndex,
      stepCount: snapshot.steps.length,
      remainingSteps: decision.remainingSteps,
      nextStepIndex: decision.nextStepIndex,
      waitingFor: decision.completesWorkflow ? null : waitingFor(snapshot.steps, snapshot),
    },
    completed: decision.completesWorkflow,
  };
}

/**
 * Reject at any step (or a QUALITY_FAILED project): the project moves to REJECTED exactly as
 * before; with a workflow the approval_tasks row carries workflowId and the current stepIndex.
 * Anyone with studio:project:approve may reject — halting publication never needs a step role.
 */
export async function rejectWithWorkflow(
  db: Db,
  tenant: TenantContext,
  id: string,
  note: string,
  now: number,
): Promise<VideoProject> {
  const project = await loadProject(db, tenant.organisationId, id);
  if (project.state !== 'READY_FOR_REVIEW' && project.state !== 'QUALITY_FAILED') {
    throw new ConflictError(
      `Project is ${project.state}; only reviewable projects can be rejected`,
    );
  }
  const snapshot =
    activeSnapshot(project.metadata) ??
    (project.state === 'READY_FOR_REVIEW'
      ? await resolveWorkflowForProject(db, project).then((w) =>
          w ? newSnapshot(w, project.metadata, now) : null,
        )
      : null);
  const progress = snapshot ? stepProgress(snapshot.steps, snapshot.approvals) : null;
  const stepIndex = progress ? Math.min(progress.currentStep, progress.stepCount - 1) : 0;
  const at = new Date(now);
  await db.$transaction(async (tx) => {
    const moved = await tx.videoProject.updateMany({
      where: { id, organisationId: tenant.organisationId, state: project.state },
      data: { state: 'REJECTED', errorReason: `rejected: ${note}`.slice(0, 2_000) },
    });
    if (moved.count === 0)
      throw new ConflictError('Project changed concurrently; reload and retry');
    await tx.approvalTask.create({
      data: {
        projectId: id,
        workflowId: snapshot?.workflowId ?? null,
        stepIndex,
        requiredRole: snapshot ? (snapshot.steps[stepIndex]?.role ?? 'reviewer') : 'reviewer',
        state: 'REJECTED',
        resolvedByUserId: tenant.userId,
        note,
        resolvedAt: at,
      },
    });
    if (snapshot) {
      await writeSnapshot(tx, id, {
        ...snapshot,
        closedAt: at.toISOString(),
        outcome: 'rejected',
      });
    }
  });
  return loadProject(db, tenant.organisationId, id);
}

// ------------------------------------------------------------------ review-screen status

export interface ApprovalStatus {
  workflow: { id: string; name: string; steps: WorkflowStep[] } | null;
  /** pending: in review (or will be); approved/rejected: the round's outcome. */
  outcome: 'pending' | 'approved' | 'rejected';
  /** True once the round has started (its steps are frozen). */
  started: boolean;
  stepIndex: number;
  stepCount: number;
  remainingSteps: number;
  waitingFor: { role: string; minApprovers: number; approvals: number } | null;
  approvals: Array<{ stepIndex: number; userId: string; at: string }>;
}

function statusFrom(snapshot: WorkflowSnapshot, started: boolean): ApprovalStatus {
  const progress = stepProgress(snapshot.steps, snapshot.approvals);
  return {
    workflow: { id: snapshot.workflowId, name: snapshot.name, steps: snapshot.steps },
    outcome: snapshot.outcome ?? 'pending',
    started,
    stepIndex: Math.min(progress.currentStep, progress.stepCount - 1),
    stepCount: progress.stepCount,
    remainingSteps: progress.remainingSteps,
    waitingFor: snapshot.outcome ? null : waitingFor(snapshot.steps, snapshot),
    approvals: snapshot.approvals.map(({ stepIndex, userId, at }) => ({ stepIndex, userId, at })),
  };
}

/** GET /projects/:id/approval — the "Step 1 of 2 — waiting for client_reviewer" indicator. */
export async function getApprovalStatus(
  db: Db,
  organisationId: string,
  id: string,
  now: number,
): Promise<ApprovalStatus> {
  const project = await loadProject(db, organisationId, id);
  const active = activeSnapshot(project.metadata);
  if (active) return statusFrom(active, true);
  const last = readSnapshot(project.metadata);
  const inReview = project.state === 'READY_FOR_REVIEW' || project.state === 'QUALITY_FAILED';
  if (last?.closedAt && !inReview) return statusFrom(last, true);
  const workflow = await resolveWorkflowForProject(db, project);
  if (!workflow) {
    return {
      workflow: null,
      outcome: 'pending',
      started: false,
      stepIndex: 0,
      stepCount: 1,
      remainingSteps: 1,
      waitingFor: null,
      approvals: [],
    };
  }
  return statusFrom(newSnapshot(workflow, project.metadata, now), false);
}

export function parseWorkflowId(value: string | undefined): string {
  const id = (value ?? '').trim();
  if (!id || id.length > 64) throw new ValidationError('Invalid approval workflow id');
  return id;
}

export type { WorkflowAppliesTo, WorkflowStep, WorkflowView };
