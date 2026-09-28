// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { ApprovalStepIndicator } from './approval-step-indicator';
import { ApprovalWorkflowsScreen } from './approval-workflows-screen';
import {
  describeAppliesTo,
  parseList,
  stepIndicatorText,
  type ApprovalStatus,
  type ApprovalWorkflow,
} from './types';
import { validateWorkflow } from './workflow-form';

// 15.D3 — approval workflow editor and the review-screen step indicator.

afterEach(() => vi.unstubAllGlobals());

const CLIENT_SIGN_OFF: ApprovalWorkflow = {
  id: 'wf_1',
  name: 'Client sign-off',
  steps: [
    { role: 'admin', minApprovers: 1 },
    { role: 'client_reviewer', minApprovers: 2 },
  ],
  appliesTo: { businessIds: ['biz_1'], platforms: ['tiktok'], tags: [] },
  createdAt: '2026-09-01T10:00:00Z',
};

const status = (over: Partial<ApprovalStatus> = {}): ApprovalStatus => ({
  workflow: { id: 'wf_1', name: 'Client sign-off', steps: CLIENT_SIGN_OFF.steps },
  outcome: 'pending',
  started: true,
  stepIndex: 1,
  stepCount: 2,
  remainingSteps: 1,
  waitingFor: { role: 'client_reviewer', minApprovers: 2, approvals: 1 },
  approvals: [],
  ...over,
});

describe('helpers', () => {
  it('describes steps, appliesTo and the waiting step', () => {
    expect(stepIndicatorText(status())).toBe(
      'Step 2 of 2 — waiting for client reviewer (1 of 2 approvals)',
    );
    expect(
      stepIndicatorText(
        status({ stepIndex: 0, waitingFor: { role: 'admin', minApprovers: 1, approvals: 0 } }),
      ),
    ).toBe('Step 1 of 2 — waiting for admin');
    expect(stepIndicatorText(status({ outcome: 'approved', waitingFor: null }))).toBe(
      'Client sign-off: every step approved',
    );
    expect(stepIndicatorText(status({ outcome: 'rejected', waitingFor: null }))).toBe(
      'Client sign-off: rejected at step 2 of 2',
    );
    expect(stepIndicatorText(status({ workflow: null }))).toBe('');
    expect(describeAppliesTo(CLIENT_SIGN_OFF.appliesTo)).toBe('Applies to business biz_1 · TikTok');
    expect(describeAppliesTo({ businessIds: [], platforms: [], tags: [] })).toBe(
      'Applies to every project',
    );
    expect(parseList(' a, b,, a ,c ')).toEqual(['a', 'b', 'c']);
  });

  it('validates a workflow like the API', () => {
    const ok = {
      name: 'X',
      steps: [{ role: 'admin', minApprovers: 1 }],
      appliesTo: CLIENT_SIGN_OFF.appliesTo,
    };
    expect(validateWorkflow(ok)).toBeNull();
    expect(validateWorkflow({ ...ok, name: ' ' })).toMatch(/name/);
    expect(validateWorkflow({ ...ok, steps: [] })).toMatch(/at least one step/);
    expect(validateWorkflow({ ...ok, steps: [{ role: 'Bad Role', minApprovers: 1 }] })).toMatch(
      /Step 1/,
    );
    expect(validateWorkflow({ ...ok, steps: [{ role: 'admin', minApprovers: 0 }] })).toMatch(
      /at least one approver/,
    );
    expect(validateWorkflow({ ...ok, steps: [{ role: 'admin', minApprovers: 11 }] })).toMatch(
      /at most 10/,
    );
  });
});

describe('ApprovalWorkflowsScreen', () => {
  it('lists workflows with their ordered steps', async () => {
    mockFetch([{ match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } }]);
    renderWithSWR(<ApprovalWorkflowsScreen />);
    const list = await screen.findByRole('list', { name: 'Approval workflows' });
    expect(within(list).getByText('Client sign-off')).toBeInTheDocument();
    expect(within(list).getByText('Applies to business biz_1 · TikTok')).toBeInTheDocument();
    const steps = within(list).getByRole('list', { name: 'Client sign-off steps' });
    expect(steps).toHaveTextContent(/Step 1:\s*admin/);
    expect(steps).toHaveTextContent(/Step 2:\s*2 client reviewers/);
  });

  it('creates a two-step workflow', async () => {
    const { calls } = mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [] } },
      {
        match: '/approval-workflows',
        method: 'POST',
        status: 201,
        body: { ok: true, workflow: CLIENT_SIGN_OFF },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<ApprovalWorkflowsScreen />);
    await screen.findByText('No approval workflows yet');
    await user.click(screen.getAllByRole('button', { name: 'New workflow' })[0] as HTMLElement);
    const form = screen.getByRole('form', { name: 'New approval workflow' });
    await user.type(within(form).getByLabelText('Name'), 'Client sign-off');
    await user.click(within(form).getByRole('button', { name: 'Add step' }));
    const approvers = within(form).getAllByLabelText('Approvers');
    await user.clear(approvers[1] as HTMLElement);
    await user.type(approvers[1] as HTMLElement, '2');
    await user.type(within(form).getByLabelText('Business ids (comma-separated)'), 'biz_1');
    await user.click(within(form).getByRole('button', { name: 'TikTok' }));
    await user.click(within(form).getByRole('button', { name: 'Create workflow' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        name: 'Client sign-off',
        steps: [
          { role: 'admin', minApprovers: 1 },
          { role: 'client_reviewer', minApprovers: 2 },
        ],
        appliesTo: { businessIds: ['biz_1'], platforms: ['tiktok'], tags: [] },
      }),
    );
  });

  it('refuses an invalid form without calling the API', async () => {
    const { calls } = mockFetch([{ match: '/approval-workflows', body: { ok: true, data: [] } }]);
    const user = userEvent.setup();
    renderWithSWR(<ApprovalWorkflowsScreen />);
    await screen.findByText('No approval workflows yet');
    await user.click(screen.getAllByRole('button', { name: 'New workflow' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the workflow a name.');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('edits (reorders steps) and deletes after confirmation', async () => {
    const { calls } = mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } },
      {
        match: '/approval-workflows/wf_1',
        method: 'PATCH',
        body: { ok: true, workflow: CLIENT_SIGN_OFF },
      },
      { match: '/approval-workflows/wf_1', method: 'DELETE', body: { ok: true, deleted: true } },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<ApprovalWorkflowsScreen />);
    await screen.findByText('Client sign-off');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit Client sign-off' });
    await user.click(within(form).getByRole('button', { name: 'Move step 2 up' }));
    await user.click(within(form).getByRole('button', { name: 'Save workflow' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        steps: [
          { role: 'client_reviewer', minApprovers: 2 },
          { role: 'admin', minApprovers: 1 },
        ],
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Delete Client sign-off' }));
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1));
  });
});

describe('ApprovalStepIndicator', () => {
  const project = { id: 'prj_1', state: 'READY_FOR_REVIEW', updatedAt: '2026-09-28T10:00:00Z' };

  it('shows "Step 2 of 2 — waiting for client reviewer" and which steps are done', async () => {
    mockFetch([{ match: '/projects/prj_1/approval', body: { ok: true, approval: status() } }]);
    renderWithSWR(<ApprovalStepIndicator project={project} />);
    const region = await screen.findByRole('region', { name: 'Approval steps' });
    expect(within(region).getByRole('status')).toHaveTextContent(
      'Step 2 of 2 — waiting for client reviewer (1 of 2 approvals)',
    );
    const items = within(region).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'current']);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
  });

  it('renders nothing without a workflow', async () => {
    const { calls } = mockFetch([
      {
        match: '/projects/prj_1/approval',
        body: { ok: true, approval: status({ workflow: null }) },
      },
    ]);
    const { container } = renderWithSWR(<ApprovalStepIndicator project={project} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('does not ask while the project is still generating', () => {
    const { calls } = mockFetch([]);
    const { container } = renderWithSWR(
      <ApprovalStepIndicator project={{ ...project, state: 'RENDERING' }} />,
    );
    expect(calls).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });
});
