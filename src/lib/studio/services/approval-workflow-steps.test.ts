import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError } from '../../errors';
import {
  activeSnapshot,
  decideStepApproval,
  explicitWorkflowId,
  matchWorkflow,
  memberRoles,
  newSnapshot,
  projectFacts,
  readSnapshot,
  specificity,
  stepProgress,
  workflowAppliesTo,
  workflowMatches,
  workflowSteps,
  type StepApproval,
  type WorkflowView,
} from './approval-workflow-steps';

// 15.D3 — the pure step machine and appliesTo matching (spec 7.13).

const TWO_STEPS = [
  { role: 'admin', minApprovers: 1 },
  { role: 'client_reviewer', minApprovers: 2 },
];

const approval = (stepIndex: number, userId: string): StepApproval => ({
  stepIndex,
  userId,
  taskId: `task-${stepIndex}-${userId}`,
  at: '2026-09-28T10:00:00.000Z',
});

const wf = (
  id: string,
  appliesTo: Partial<WorkflowView['appliesTo']>,
  createdAt = '2026-01-01T00:00:00Z',
): WorkflowView => ({
  id,
  organisationId: 'org-1',
  name: id,
  steps: TWO_STEPS,
  appliesTo: { platforms: [], businessIds: [], tags: [], ...appliesTo },
  createdAt: new Date(createdAt),
});

describe('stepProgress', () => {
  it('starts at step 0 with every step remaining', () => {
    expect(stepProgress(TWO_STEPS, [])).toEqual({
      stepCount: 2,
      currentStep: 0,
      approvalsInStep: 0,
      remainingSteps: 2,
      complete: false,
    });
  });

  it('counts distinct approvers per step and moves on once minApprovers is met', () => {
    const approvals = [approval(0, 'a'), approval(1, 'b'), approval(1, 'b')];
    expect(stepProgress(TWO_STEPS, approvals)).toMatchObject({
      currentStep: 1,
      approvalsInStep: 1,
      remainingSteps: 1,
      complete: false,
    });
    expect(stepProgress(TWO_STEPS, [...approvals, approval(1, 'c')])).toMatchObject({
      currentStep: 2,
      remainingSteps: 0,
      complete: true,
    });
  });
});

describe('decideStepApproval', () => {
  it('advances to the next step when the step completes', () => {
    expect(decideStepApproval(TWO_STEPS, [], { userId: 'a', roles: ['admin'] })).toEqual({
      stepIndex: 0,
      requiredRole: 'admin',
      completesStep: true,
      completesWorkflow: false,
      remainingSteps: 1,
      nextStepIndex: 1,
    });
  });

  it('stays on a step until minApprovers distinct people approved it', () => {
    const first = decideStepApproval(TWO_STEPS, [approval(0, 'a')], {
      userId: 'b',
      roles: ['client_reviewer'],
    });
    expect(first).toMatchObject({
      stepIndex: 1,
      completesStep: false,
      completesWorkflow: false,
      remainingSteps: 1,
      nextStepIndex: 1,
    });
    const second = decideStepApproval(TWO_STEPS, [approval(0, 'a'), approval(1, 'b')], {
      userId: 'c',
      roles: ['client_reviewer'],
    });
    expect(second).toMatchObject({
      stepIndex: 1,
      completesStep: true,
      completesWorkflow: true,
      remainingSteps: 0,
      nextStepIndex: null,
    });
  });

  it('refuses an approver without the step role (403) and names the role', () => {
    let error: unknown;
    try {
      decideStepApproval(TWO_STEPS, [], { userId: 'a', roles: ['client_reviewer', 'member'] });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).message).toBe('Step 1 of 2 needs approval from a admin');
    expect((error as ForbiddenError).details).toEqual({ requiredRole: 'admin', stepIndex: 0 });
  });

  it('refuses the same person twice in one step (409)', () => {
    expect(() =>
      decideStepApproval(TWO_STEPS, [approval(0, 'a'), approval(1, 'b')], {
        userId: 'b',
        roles: ['client_reviewer'],
      }),
    ).toThrow(ConflictError);
  });

  it('lets the same person approve different steps when they hold both roles', () => {
    expect(
      decideStepApproval(TWO_STEPS, [approval(0, 'a')], {
        userId: 'a',
        roles: ['admin', 'client_reviewer'],
      }).stepIndex,
    ).toBe(1);
  });

  it('refuses once every step is complete', () => {
    const done = [approval(0, 'a'), approval(1, 'b'), approval(1, 'c')];
    expect(() => decideStepApproval(TWO_STEPS, done, { userId: 'd', roles: ['admin'] })).toThrow(
      ConflictError,
    );
  });
});

describe('matching', () => {
  const facts = { businessId: 'biz-1', platforms: ['tiktok', 'linkedin_video'], tags: ['legal'] };

  it('matches every non-empty criterion (platforms/tags by overlap)', () => {
    expect(workflowMatches(wf('a', {}).appliesTo, facts)).toBe(true);
    expect(workflowMatches(wf('a', { businessIds: ['biz-2'] }).appliesTo, facts)).toBe(false);
    expect(workflowMatches(wf('a', { platforms: ['x', 'tiktok'] }).appliesTo, facts)).toBe(true);
    expect(workflowMatches(wf('a', { platforms: ['youtube'] }).appliesTo, facts)).toBe(false);
    expect(workflowMatches(wf('a', { tags: ['legal'] }).appliesTo, facts)).toBe(true);
    expect(
      workflowMatches(wf('a', { businessIds: ['biz-1'], tags: ['other'] }).appliesTo, facts),
    ).toBe(false);
  });

  it('ranks business > tags > platforms > catch-all', () => {
    expect(specificity(wf('a', {}).appliesTo)).toBe(0);
    expect(specificity(wf('a', { platforms: ['x'] }).appliesTo)).toBe(1);
    expect(specificity(wf('a', { tags: ['t'] }).appliesTo)).toBe(2);
    expect(specificity(wf('a', { businessIds: ['b'], platforms: ['x'] }).appliesTo)).toBe(5);
  });

  it('picks the most specific match, then the oldest, then the lowest id', () => {
    const all = [
      wf('catch-all', {}),
      wf('platform', { platforms: ['tiktok'] }),
      wf('biz-new', { businessIds: ['biz-1'] }, '2026-03-01T00:00:00Z'),
      wf('biz-old', { businessIds: ['biz-1'] }, '2026-02-01T00:00:00Z'),
    ];
    expect(matchWorkflow(all, facts)?.id).toBe('biz-old');
    const tie = [
      wf('b-id', { businessIds: ['biz-1'] }, '2026-02-01T00:00:00Z'),
      wf('a-id', { businessIds: ['biz-1'] }, '2026-02-01T00:00:00Z'),
    ];
    expect(matchWorkflow(tie, facts)?.id).toBe('a-id');
    expect(matchWorkflow([wf('x', { businessIds: ['other'] })], facts)).toBeNull();
    expect(matchWorkflow([], facts)).toBeNull();
  });

  it('reads project facts from targetFormats and metadata.tags', () => {
    expect(
      projectFacts({
        businessId: 'biz-1',
        targetFormats: [{ platform: 'tiktok' }, { platform: 'x' }, { nope: 1 }],
        metadata: { tags: ['Legal', 3] },
      }),
    ).toEqual({ businessId: 'biz-1', platforms: ['tiktok', 'x'], tags: ['legal'] });
    expect(projectFacts({ businessId: 'b', targetFormats: null, metadata: null })).toEqual({
      businessId: 'b',
      platforms: [],
      tags: [],
    });
  });

  it('reads an explicitly chosen workflow id', () => {
    expect(explicitWorkflowId({ approvalWorkflowId: 'wf_1' })).toBe('wf_1');
    expect(explicitWorkflowId({ approvalWorkflowId: 5 })).toBeNull();
    expect(explicitWorkflowId(null)).toBeNull();
  });
});

describe('snapshots', () => {
  const workflow = wf('wf-1', {});

  it('freezes the steps and the run at the first approval', () => {
    const snap = newSnapshot(workflow, { runId: 'run-1' }, Date.parse('2026-09-28T10:00:00Z'));
    expect(snap).toEqual({
      workflowId: 'wf-1',
      name: 'wf-1',
      steps: TWO_STEPS,
      runId: 'run-1',
      startedAt: '2026-09-28T10:00:00.000Z',
      approvals: [],
    });
    const metadata = { runId: 'run-1', approvalWorkflow: snap };
    expect(readSnapshot(metadata)).toEqual(snap);
    expect(activeSnapshot(metadata)).toEqual(snap);
  });

  it('treats a closed round or a new generation run as no active round', () => {
    const snap = newSnapshot(workflow, { runId: 'run-1' }, 0);
    expect(activeSnapshot({ runId: 'run-2', approvalWorkflow: snap })).toBeNull();
    expect(
      activeSnapshot({ runId: 'run-1', approvalWorkflow: { ...snap, closedAt: 'x' } }),
    ).toBeNull();
    expect(activeSnapshot({ approvalWorkflow: { junk: true } })).toBeNull();
    expect(activeSnapshot(null)).toBeNull();
  });
});

describe('schemas', () => {
  it('normalises roles and de-duplicates appliesTo lists', () => {
    expect(workflowSteps.parse([{ role: ' Client_Reviewer ', minApprovers: 2 }])).toEqual([
      { role: 'client_reviewer', minApprovers: 2 },
    ]);
    expect(
      workflowAppliesTo.parse({ businessIds: ['b', 'b'], platforms: ['x', 'x'], tags: ['T'] }),
    ).toEqual({ businessIds: ['b'], platforms: ['x'], tags: ['t'] });
    expect(workflowAppliesTo.parse({})).toEqual({ businessIds: [], platforms: [], tags: [] });
  });

  it('rejects empty, oversized and malformed steps', () => {
    expect(workflowSteps.safeParse([]).success).toBe(false);
    expect(workflowSteps.safeParse([{ role: 'admin', minApprovers: 0 }]).success).toBe(false);
    expect(workflowSteps.safeParse([{ role: 'admin', minApprovers: 11 }]).success).toBe(false);
    expect(workflowSteps.safeParse([{ role: 'no spaces', minApprovers: 1 }]).success).toBe(false);
    expect(
      workflowSteps.safeParse(Array.from({ length: 11 }, () => ({ role: 'a', minApprovers: 1 })))
        .success,
    ).toBe(false);
    expect(workflowAppliesTo.safeParse({ platforms: ['myspace'] }).success).toBe(false);
  });

  it('normalises membership roles for the organisation only', () => {
    expect(
      memberRoles({
        organisationId: 'org-1',
        memberships: [
          { organisationId: 'org-1', role: ' Admin ' },
          { organisationId: 'org-2', role: 'client_reviewer' },
        ],
      }),
    ).toEqual(['admin']);
  });
});
