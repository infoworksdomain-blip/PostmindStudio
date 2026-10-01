import { z } from 'zod';
import { ConflictError, ForbiddenError } from '../../errors';
import { PLATFORMS } from './catalog';

// 15.D3 — the pure half of multi-step approval workflows (spec 7.13 approval_workflows.steps
// "ordered [{ role, minApprovers }]", appliesTo "{platforms, businessIds, tags}"; spec 3.3 agency
// "approval workflows"). No I/O here: services/approval-workflows.ts loads rows, locks the
// project and persists what these functions decide.

export const MAX_WORKFLOW_STEPS = 10;
export const MAX_APPROVERS_PER_STEP = 10;

/** Core membership role names: lower-case letters, digits, `_`, `-`, `:` (e.g. client_reviewer). */
const ROLE = /^[a-z][a-z0-9_:-]{0,63}$/;

export const workflowStep = z
  .object({
    role: z
      .string()
      .trim()
      .toLowerCase()
      .regex(ROLE, 'role must be a membership role name such as admin or client_reviewer'),
    minApprovers: z.number().int().min(1).max(MAX_APPROVERS_PER_STEP),
  })
  .strict();

export const workflowSteps = z.array(workflowStep).min(1).max(MAX_WORKFLOW_STEPS);

const idList = (max: number) =>
  z
    .array(z.string().trim().min(1).max(128))
    .max(max)
    .transform((v) => [...new Set(v)]);

export const workflowAppliesTo = z
  .object({
    platforms: z
      .array(z.enum(PLATFORMS))
      .max(PLATFORMS.length)
      .transform((v) => [...new Set(v)])
      .default([]),
    businessIds: idList(100).default([]),
    tags: z
      .array(z.string().trim().toLowerCase().min(1).max(40))
      .max(50)
      .transform((v) => [...new Set(v)])
      .default([]),
  })
  .strict();

export type WorkflowStep = z.infer<typeof workflowStep>;
export type WorkflowAppliesTo = z.infer<typeof workflowAppliesTo>;

export interface WorkflowView {
  id: string;
  organisationId: string;
  name: string;
  steps: WorkflowStep[];
  appliesTo: WorkflowAppliesTo;
  createdAt: Date;
}

export interface ProjectFacts {
  businessId: string;
  platforms: string[];
  tags: string[];
}

/** One recorded approval inside a review round (the approval_tasks row is the audit trail). */
export interface StepApproval {
  stepIndex: number;
  userId: string;
  taskId: string;
  at: string;
}

/**
 * What applies to one review round of a project, frozen at its first approval (stored at
 * video_projects.metadata.approvalWorkflow). Later edits to — or deletion of — the workflow
 * never change a round already under way; they apply from the project's next review round.
 */
export interface WorkflowSnapshot {
  workflowId: string;
  name: string;
  steps: WorkflowStep[];
  /** metadata.runId when the round started: a new generation run starts a new round. */
  runId: string | null;
  startedAt: string;
  approvals: StepApproval[];
  closedAt?: string;
  outcome?: 'approved' | 'rejected';
}

const snapshotSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string(),
  steps: workflowSteps,
  runId: z.string().nullable(),
  startedAt: z.string(),
  approvals: z.array(
    z.object({
      stepIndex: z.number().int().min(0),
      userId: z.string().min(1),
      taskId: z.string().min(1),
      at: z.string(),
    }),
  ),
  closedAt: z.string().optional(),
  outcome: z.enum(['approved', 'rejected']).optional(),
});

export const SNAPSHOT_KEY = 'approvalWorkflow';
/** 15.C4 create-screen picker: an explicitly chosen workflow id beats appliesTo matching. */
export const EXPLICIT_WORKFLOW_KEY = 'approvalWorkflowId';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readSnapshot(metadata: unknown): WorkflowSnapshot | null {
  const parsed = snapshotSchema.safeParse(asRecord(metadata)[SNAPSHOT_KEY]);
  return parsed.success ? parsed.data : null;
}

/** The snapshot of the round in progress, or null when there is none (or it is finished/stale). */
export function activeSnapshot(metadata: unknown): WorkflowSnapshot | null {
  const snapshot = readSnapshot(metadata);
  if (!snapshot || snapshot.closedAt) return null;
  const runId = asRecord(metadata).runId;
  return snapshot.runId === (typeof runId === 'string' ? runId : null) ? snapshot : null;
}

export function explicitWorkflowId(metadata: unknown): string | null {
  const id = asRecord(metadata)[EXPLICIT_WORKFLOW_KEY];
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

export function newSnapshot(workflow: WorkflowView, metadata: unknown, now: number) {
  const runId = asRecord(metadata).runId;
  return {
    workflowId: workflow.id,
    name: workflow.name,
    steps: workflow.steps,
    runId: typeof runId === 'string' ? runId : null,
    startedAt: new Date(now).toISOString(),
    approvals: [],
  } satisfies WorkflowSnapshot;
}

/** Platforms (from targetFormats) and tags (metadata.tags, when a project carries any). */
export function projectFacts(project: {
  businessId: string;
  targetFormats: unknown;
  metadata: unknown;
}): ProjectFacts {
  const formats = Array.isArray(project.targetFormats) ? project.targetFormats : [];
  const platforms = formats.flatMap((f) => {
    const platform = asRecord(f).platform;
    return typeof platform === 'string' ? [platform] : [];
  });
  const rawTags = asRecord(project.metadata).tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.flatMap((t) => (typeof t === 'string' ? [t.trim().toLowerCase()] : []))
    : [];
  return { businessId: project.businessId, platforms, tags };
}

/**
 * How specific an appliesTo is: a named business (a client, spec 3.3) outranks tags, which
 * outrank platforms. An empty appliesTo (0) is the organisation-wide catch-all.
 */
export function specificity(appliesTo: WorkflowAppliesTo): number {
  return (
    (appliesTo.businessIds.length ? 4 : 0) +
    (appliesTo.tags.length ? 2 : 0) +
    (appliesTo.platforms.length ? 1 : 0)
  );
}

/** Every non-empty criterion must match (platforms/tags: any overlap). */
export function workflowMatches(appliesTo: WorkflowAppliesTo, facts: ProjectFacts): boolean {
  if (appliesTo.businessIds.length && !appliesTo.businessIds.includes(facts.businessId))
    return false;
  if (appliesTo.platforms.length && !appliesTo.platforms.some((p) => facts.platforms.includes(p)))
    return false;
  if (appliesTo.tags.length && !appliesTo.tags.some((t) => facts.tags.includes(t))) return false;
  return true;
}

/**
 * The workflow for a project: the most specific match wins; ties go to the oldest workflow,
 * then the lowest id (deterministic). No match = the single-step approval of phases 4–14.
 */
export function matchWorkflow(workflows: WorkflowView[], facts: ProjectFacts): WorkflowView | null {
  const ranked = workflows
    .filter((w) => workflowMatches(w.appliesTo, facts))
    .sort(
      (a, b) =>
        specificity(b.appliesTo) - specificity(a.appliesTo) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return ranked[0] ?? null;
}

export interface StepProgress {
  stepCount: number;
  /** First step still short of approvals; equals stepCount once every step is complete. */
  currentStep: number;
  /** Distinct approvers recorded against currentStep. */
  approvalsInStep: number;
  /** Steps not yet complete. */
  remainingSteps: number;
  complete: boolean;
}

function approversOf(approvals: StepApproval[], stepIndex: number): Set<string> {
  return new Set(approvals.filter((a) => a.stepIndex === stepIndex).map((a) => a.userId));
}

export function stepProgress(steps: WorkflowStep[], approvals: StepApproval[]): StepProgress {
  let current = 0;
  while (current < steps.length) {
    const step = steps[current] as WorkflowStep;
    if (approversOf(approvals, current).size < step.minApprovers) break;
    current += 1;
  }
  return {
    stepCount: steps.length,
    currentStep: current,
    approvalsInStep: current < steps.length ? approversOf(approvals, current).size : 0,
    remainingSteps: steps.length - current,
    complete: current >= steps.length,
  };
}

export interface StepDecision {
  /** The step this approval is recorded against. */
  stepIndex: number;
  requiredRole: string;
  completesStep: boolean;
  /** The last step is now complete: the project may move to APPROVED. */
  completesWorkflow: boolean;
  /** Steps still incomplete after this approval. */
  remainingSteps: number;
  /** The step now waiting for approvals (null once the workflow is complete). */
  nextStepIndex: number | null;
}

/**
 * One human approval against the current step. The approver must hold the step's membership
 * role; the same person counts once per step (a second approval of the same step is a 409);
 * the step completes when minApprovers distinct people have approved it.
 */
export function decideStepApproval(
  steps: WorkflowStep[],
  approvals: StepApproval[],
  actor: { userId: string; roles: string[] },
): StepDecision {
  const progress = stepProgress(steps, approvals);
  if (progress.complete) throw new ConflictError('Every approval step is already complete');
  const stepIndex = progress.currentStep;
  const step = steps[stepIndex] as WorkflowStep;
  const label = `Step ${stepIndex + 1} of ${steps.length}`;
  if (!actor.roles.includes(step.role)) {
    throw new ForbiddenError(`${label} needs approval from a ${step.role}`, {
      requiredRole: step.role,
      stepIndex,
    });
  }
  if (approversOf(approvals, stepIndex).has(actor.userId)) {
    throw new ConflictError(
      `You have already approved ${label.toLowerCase()}; it needs ${step.minApprovers} different ${step.role} approvers`,
      { stepIndex, requiredRole: step.role },
    );
  }
  const completesStep = progress.approvalsInStep + 1 >= step.minApprovers;
  const completesWorkflow = completesStep && stepIndex === steps.length - 1;
  return {
    stepIndex,
    requiredRole: step.role,
    completesStep,
    completesWorkflow,
    remainingSteps: steps.length - stepIndex - (completesStep ? 1 : 0),
    nextStepIndex: completesWorkflow ? null : completesStep ? stepIndex + 1 : stepIndex,
  };
}

/** The organisation-scoped membership roles of the caller, normalised like step roles. */
export function memberRoles(tenant: {
  organisationId: string;
  memberships: Array<{ organisationId: string; role: string }>;
}): string[] {
  return tenant.memberships
    .filter((m) => m.organisationId === tenant.organisationId)
    .map((m) => m.role.trim().toLowerCase());
}

/**
 * Step roles (de-duplicated, in order) that no holder of `approverRoles` can satisfy. Standalone
 * organisations only have owner / admin / publisher / creator / viewer, and only the first three
 * may approve, so a `client_reviewer` or `legal` step would leave every review waiting forever.
 */
export function unapprovableStepRoles<T extends { role: string }>(
  steps: readonly T[],
  approverRoles: readonly string[],
): string[] {
  return [...new Set(steps.map((s) => s.role))].filter((role) => !approverRoles.includes(role));
}
