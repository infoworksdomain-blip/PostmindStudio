// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetRaise, isProjectBudgetPause, suggestedBudgetPence } from './budget-raise';
import { makeProject, mockFetch, renderWithSWR, type MockRoute } from './test-helpers';

const meAs = (platformRole: string): MockRoute => ({
  match: '/me',
  body: { ok: true, me: { capabilities: [], user: { platformRole } } },
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const pausedReason =
  'cost_cap_paused: project reached 90% of its budget (£3.15 of £3.50). Raise the budget on the project page (or PATCH costBudgetPence), then generate again';

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('isProjectBudgetPause', () => {
  it('matches only a FAILED project paused by its own budget', () => {
    expect(isProjectBudgetPause({ state: 'FAILED', errorReason: pausedReason })).toBe(true);
    expect(
      isProjectBudgetPause({
        state: 'FAILED',
        errorReason: 'cost_cap_paused: organisation monthly cost cap reached',
      }),
    ).toBe(false);
    expect(isProjectBudgetPause({ state: 'READY_FOR_REVIEW', errorReason: pausedReason })).toBe(
      false,
    );
    expect(isProjectBudgetPause({ state: 'FAILED', errorReason: null })).toBe(false);
  });
});

describe('suggestedBudgetPence', () => {
  it('doubles the budget, at least £1 over what was spent, in whole pounds', () => {
    expect(suggestedBudgetPence({ costBudgetPence: 350, costActualPence: 315 })).toBe(700);
    expect(suggestedBudgetPence({ costBudgetPence: null, costActualPence: 315 })).toBe(500);
    expect(suggestedBudgetPence({ costBudgetPence: 100, costActualPence: 290 })).toBe(400);
  });
});

describe('BudgetRaise (staff)', () => {
  const project = makeProject({
    id: 'proj_9',
    state: 'FAILED',
    errorReason: pausedReason,
    costBudgetPence: 350,
    costActualPence: 315,
  });

  it('explains the pause and raises the budget with PATCH /projects/:id', async () => {
    const onChanged = vi.fn();
    const fetch = mockFetch([
      meAs('staff'),
      { method: 'PATCH', match: '/projects/proj_9', body: { ok: true, project: {} } },
    ]);
    renderWithSWR(<BudgetRaise project={project} onChanged={onChanged} />);
    expect(await screen.findByRole('region', { name: 'Raise budget' })).toHaveTextContent(
      'Generation paused at 90% of this project’s budget (£3.15 of £3.50 spent)',
    );
    const input = screen.getByLabelText('New budget (£)');
    expect(input).toHaveValue('7.00'); // suggested: double the current budget
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    await userEvent.click(screen.getByRole('button', { name: 'Raise budget' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetch.find('PATCH', '/projects/proj_9')[0]?.body).toEqual({ costBudgetPence: 1_000 });
    expect(toast.success).toHaveBeenCalledWith(
      'Budget raised to £10.00. Press “Generate again” to continue.',
    );
  });

  it('refuses a budget that is not higher than the current one', async () => {
    mockFetch([meAs('superadmin')]);
    renderWithSWR(<BudgetRaise project={project} onChanged={vi.fn()} />);
    const input = await screen.findByLabelText('New budget (£)');
    await userEvent.clear(input);
    await userEvent.type(input, '3.50');
    expect(screen.getByRole('button', { name: 'Raise budget' })).toBeDisabled();
    expect(screen.getByText('Enter more than £3.50 (up to £100,000).')).toBeInTheDocument();
  });
});

// Needs the review.budget.limitAria / limitReached / carryOn / carriedOn keys from
// .i18n-tmp/frag-costs/en-GB.json.
describe('BudgetRaise (customers, operator decision 2026-10-04)', () => {
  const project = makeProject({
    id: 'proj_9',
    state: 'FAILED',
    errorReason: pausedReason,
    costBudgetPence: 350,
    costActualPence: 315,
  });

  it('shows no amounts and carries on with the suggested budget in one press', async () => {
    const onChanged = vi.fn();
    const fetch = mockFetch([
      meAs('user'),
      { method: 'PATCH', match: '/projects/proj_9', body: { ok: true, project: {} } },
    ]);
    const { container } = renderWithSWR(<BudgetRaise project={project} onChanged={onChanged} />);
    await waitFor(() => expect(fetch.find('GET', '/me')).toHaveLength(1));
    expect(container).not.toHaveTextContent(/£|\d+%|budget|spen[dt]/i);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Carry on making this video' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetch.find('PATCH', '/projects/proj_9')[0]?.body).toEqual({ costBudgetPence: 700 });
    const [message] = toast.success.mock.calls[0] ?? [];
    expect(String(message)).not.toMatch(/£|budget/i);
  });
});
