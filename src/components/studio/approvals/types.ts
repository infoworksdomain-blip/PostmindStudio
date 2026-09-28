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
export const SUGGESTED_ROLES = ['owner', 'admin', 'client_reviewer', 'legal', 'reviewer'] as const;

export type SuggestedRole = (typeof SUGGESTED_ROLES)[number];

export function isSuggestedRole(role: string): role is SuggestedRole {
  return (SUGGESTED_ROLES as readonly string[]).includes(role);
}

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
