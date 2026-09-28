import { PLATFORM_LABEL } from '@/lib/client/format';

// 15.D3 — client-side shapes of /approval-workflows and /projects/:id/approval
// (src/lib/studio/services/approval-workflows.ts).

export interface WorkflowStep {
  role: string;
  minApprovers: number;
}

export interface WorkflowAppliesTo {
  platforms: string[];
  businessIds: string[];
  tags: string[];
}

export interface ApprovalWorkflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  appliesTo: WorkflowAppliesTo;
  createdAt: string;
}

export interface WorkflowInput {
  name: string;
  steps: WorkflowStep[];
  appliesTo: WorkflowAppliesTo;
}

export interface ApprovalStatus {
  workflow: { id: string; name: string; steps: WorkflowStep[] } | null;
  outcome: 'pending' | 'approved' | 'rejected';
  started: boolean;
  stepIndex: number;
  stepCount: number;
  remainingSteps: number;
  waitingFor: { role: string; minApprovers: number; approvals: number } | null;
  approvals: Array<{ stepIndex: number; userId: string; at: string }>;
}

/** Suggested Core membership roles; any role name is accepted. */
export const SUGGESTED_ROLES = ['owner', 'admin', 'client_reviewer', 'legal', 'reviewer'];

/** Platforms a workflow can be limited to (services/catalog.ts PLATFORMS). */
export const WORKFLOW_PLATFORMS = Object.keys(PLATFORM_LABEL);

export function roleLabel(role: string): string {
  return role.replace(/[_:-]+/g, ' ');
}

/** "a, b ,, c" → ['a', 'b', 'c'] (trimmed, de-duplicated). */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** One line describing which projects a workflow applies to. */
export function describeAppliesTo(appliesTo: WorkflowAppliesTo): string {
  const parts: string[] = [];
  if (appliesTo.businessIds.length)
    parts.push(
      `${appliesTo.businessIds.length === 1 ? 'business' : 'businesses'} ${appliesTo.businessIds.join(', ')}`,
    );
  if (appliesTo.platforms.length)
    parts.push(appliesTo.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(' / '));
  if (appliesTo.tags.length) parts.push(`tagged ${appliesTo.tags.join(', ')}`);
  return parts.length ? `Applies to ${parts.join(' · ')}` : 'Applies to every project';
}

/** "admin" (one approver) or "2 client reviewers". */
export function describeStep(step: WorkflowStep): string {
  return step.minApprovers === 1
    ? roleLabel(step.role)
    : `${step.minApprovers} ${roleLabel(step.role)}s`;
}

/** "Step 1 of 2 — waiting for client reviewer (1 of 2 approvals)". */
export function stepIndicatorText(status: ApprovalStatus): string {
  if (!status.workflow) return '';
  const name = status.workflow.name;
  if (status.outcome === 'approved') return `${name}: every step approved`;
  if (status.outcome === 'rejected')
    return `${name}: rejected at step ${status.stepIndex + 1} of ${status.stepCount}`;
  const step = `Step ${status.stepIndex + 1} of ${status.stepCount}`;
  const waiting = status.waitingFor;
  if (!waiting) return `${name}: ${step}`;
  const count =
    waiting.minApprovers > 1 ? ` (${waiting.approvals} of ${waiting.minApprovers} approvals)` : '';
  return `${step} — waiting for ${roleLabel(waiting.role)}${count}`;
}
