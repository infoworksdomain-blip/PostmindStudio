// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetRaise, isProjectBudgetPause } from './budget-raise';
import { makeProject, mockFetch, renderWithSWR } from './test-helpers';

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

describe('BudgetRaise', () => {
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
      { method: 'PATCH', match: '/projects/proj_9', body: { ok: true, project: {} } },
    ]);
    renderWithSWR(<BudgetRaise project={project} onChanged={onChanged} />);
    expect(screen.getByRole('region', { name: 'Raise budget' })).toHaveTextContent(
      "Generation paused at 90% of this project's budget (£3.15 of £3.50 spent)",
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
    mockFetch([]);
    renderWithSWR(<BudgetRaise project={project} onChanged={vi.fn()} />);
    const input = screen.getByLabelText('New budget (£)');
    await userEvent.clear(input);
    await userEvent.type(input, '3.50');
    expect(screen.getByRole('button', { name: 'Raise budget' })).toBeDisabled();
    expect(screen.getByText('Enter more than £3.50 (up to £100,000).')).toBeInTheDocument();
  });
});
