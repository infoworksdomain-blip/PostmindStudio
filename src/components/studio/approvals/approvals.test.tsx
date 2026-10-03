// @vitest-environment jsdom
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { useApprovalText } from './approval-text';
import { ApprovalStepIndicator } from './approval-step-indicator';
import { ApprovalWorkflowsScreen } from './approval-workflows-screen';
import { parseList, type ApprovalStatus, type ApprovalWorkflow } from './types';
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
    const { describeAppliesTo, describeStep, stepIndicatorText } = renderHook(() =>
      useApprovalText(),
    ).result.current;
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
    // While the business list loads, and when a business is gone, the raw id is never shown.
    expect(describeAppliesTo(CLIENT_SIGN_OFF.appliesTo)).toBe(
      'Applies to business a business · TikTok',
    );
    expect(describeAppliesTo(CLIENT_SIGN_OFF.appliesTo, {})).toBe(
      'Applies to business a removed business · TikTok',
    );
    expect(describeAppliesTo(CLIENT_SIGN_OFF.appliesTo, { biz_1: 'Leeds Sourdough' })).toBe(
      'Applies to business Leeds Sourdough · TikTok',
    );
    expect(describeAppliesTo({ businessIds: [], platforms: [], tags: [] })).toBe(
      'Applies to every project',
    );
    expect(describeStep({ role: 'client_reviewer', minApprovers: 2 })).toBe('2 client reviewers');
    expect(describeStep({ role: 'brand:lead', minApprovers: 1 })).toBe('brand lead');
    expect(parseList(' a, b,, a ,c ')).toEqual(['a', 'b', 'c']);
  });

  it('validates a workflow like the API', () => {
    const ok = {
      name: 'X',
      steps: [{ role: 'admin', minApprovers: 1 }],
      appliesTo: CLIENT_SIGN_OFF.appliesTo,
    };
    expect(validateWorkflow(ok)).toBeNull();
    expect(validateWorkflow({ ...ok, name: ' ' })).toEqual({ code: 'name' });
    expect(validateWorkflow({ ...ok, steps: [] })).toEqual({ code: 'noSteps' });
    expect(validateWorkflow({ ...ok, steps: [{ role: 'Bad Role', minApprovers: 1 }] })).toEqual({
      code: 'role',
      step: 1,
    });
    expect(validateWorkflow({ ...ok, steps: [{ role: 'admin', minApprovers: 0 }] })).toEqual({
      code: 'minApprovers',
      step: 1,
    });
    expect(validateWorkflow({ ...ok, steps: [{ role: 'admin', minApprovers: 11 }] })).toEqual({
      code: 'maxApprovers',
      step: 1,
      max: 10,
    });
  });
});

describe('ApprovalWorkflowsScreen', () => {
  it('lists workflows with their ordered steps', async () => {
    mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } },
      {
        match: '/businesses',
        body: { ok: true, data: [{ id: 'biz_1', name: 'Leeds Sourdough' }] },
      },
    ]);
    renderWithSWR(<ApprovalWorkflowsScreen />);
    const list = await screen.findByRole('list', { name: 'Approval workflows' });
    expect(within(list).getByText('Client sign-off')).toBeInTheDocument();
    expect(within(list).queryByText(/biz_1/)).not.toBeInTheDocument();
    const steps = within(list).getByRole('list', { name: 'Client sign-off steps' });
    expect(steps).toHaveTextContent(/Step 1:\s*admin/);
    expect(steps).toHaveTextContent(/Step 2:\s*2 client reviewers/);
  });

  it('says "a removed business" and warns when the business is not in the organisation', async () => {
    mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } },
      { match: '/businesses', body: { ok: true, data: [{ id: 'biz_2', name: 'Other Bakery' }] } },
    ]);
    renderWithSWR(<ApprovalWorkflowsScreen />);
    expect(
      await screen.findByText('Applies to business a removed business · TikTok'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer applies/);
    expect(screen.queryByText(/biz_1/)).not.toBeInTheDocument();
  });

  it('shows the business name, not its id, on the card', async () => {
    mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } },
      {
        match: '/businesses',
        body: { ok: true, data: [{ id: 'biz_1', name: 'Leeds Sourdough' }] },
      },
    ]);
    renderWithSWR(<ApprovalWorkflowsScreen />);
    expect(
      await screen.findByText('Applies to business Leeds Sourdough · TikTok'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/biz_1/)).not.toBeInTheDocument();
  });

  it('creates a two-step workflow, picking the business by name', async () => {
    const { calls } = mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [] } },
      {
        match: '/businesses',
        body: { ok: true, data: [{ id: 'biz_1', name: 'Leeds Sourdough' }] },
      },
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
    const picker = within(form).getByRole('group', { name: 'Businesses' });
    expect(within(form).queryByLabelText(/Business ids/)).not.toBeInTheDocument();
    await user.click(await within(picker).findByRole('button', { name: 'Leeds Sourdough' }));
    expect(within(picker).getByRole('button', { name: 'Leeds Sourdough' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(form).getByRole('button', { name: 'TikTok' }));
    await user.click(within(form).getByRole('button', { name: 'Create workflow' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        name: 'Client sign-off',
        steps: [
          { role: 'admin', minApprovers: 1 },
          { role: 'publisher', minApprovers: 2 },
        ],
        appliesTo: { businessIds: ['biz_1'], platforms: ['tiktok'], tags: [] },
      }),
    );
  });

  it('keeps a saved business the list no longer has, so it can be removed', async () => {
    mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } },
      { match: '/businesses', body: { ok: true, data: [{ id: 'biz_2', name: 'Other Bakery' }] } },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<ApprovalWorkflowsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const picker = within(screen.getByRole('form', { name: 'Edit Client sign-off' })).getByRole(
      'group',
      { name: 'Businesses' },
    );
    const stale = within(picker).getByRole('button', { name: 'a removed business' });
    expect(stale).toHaveAttribute('aria-pressed', 'true');
    await user.click(stale);
    // Unselected, the removed business drops out of the choices.
    expect(within(picker).queryByRole('button', { name: 'a removed business' })).toBeNull();
    expect(within(picker).getByRole('button', { name: 'Other Bakery' })).toHaveAttribute(
      'aria-pressed',
      'false',
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

describe('approval workflows localisation', () => {
  it('renders the workflows screen in Arabic, right to left', async () => {
    mockFetch([{ match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } }]);
    renderWithSWR(withLocale('ar', <ApprovalWorkflowsScreen />));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'مسارات الموافقة' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'مسارات الموافقة' });
    // The workflow name is user content: never translated.
    expect(within(list).getByText('Client sign-off')).toBeInTheDocument();
    const steps = within(list).getByRole('list', { name: 'خطوات Client sign-off' });
    expect(steps).toHaveTextContent('مسؤول');
    expect(steps).toHaveTextContent('مراجعان من العميل');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('renders the workflows screen and the step indicator in Simplified Chinese', async () => {
    mockFetch([
      { match: '/approval-workflows', body: { ok: true, data: [CLIENT_SIGN_OFF] } },
      {
        match: '/businesses',
        body: { ok: true, data: [{ id: 'biz_1', name: 'Leeds Sourdough' }] },
      },
      { match: '/projects/prj_1/approval', body: { ok: true, approval: status() } },
    ]);
    renderWithSWR(
      withLocale(
        'zh-Hans',
        <>
          <ApprovalWorkflowsScreen />
          <ApprovalStepIndicator project={{ id: 'prj_1', state: 'READY_FOR_REVIEW' }} />
        </>,
      ),
    );
    expect(await screen.findByRole('heading', { level: 1, name: '审批流程' })).toBeInTheDocument();
    expect(await screen.findByText('适用于：商家 Leeds Sourdough · TikTok')).toBeInTheDocument();
    const region = await screen.findByRole('region', { name: '审批步骤' });
    expect(within(region).getByRole('status')).toHaveTextContent(
      '第 2 步，共 2 步——等待客户审核人（已获 1/2 项批准）',
    );
  });
});
