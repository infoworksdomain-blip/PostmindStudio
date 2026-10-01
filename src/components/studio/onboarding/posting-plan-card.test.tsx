// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { CelebrateStep } from './celebrate-step';
import { PostingPlanCard } from './posting-plan-card';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const QUEUE = '/businesses/biz_1/drip-queue';

describe('PostingPlanCard (20.3, 20.14)', () => {
  function server() {
    let saved: unknown = null;
    return mockFetch((req) => {
      if (!req.url.pathname.endsWith('/drip-queue')) return undefined;
      if (req.method === 'PUT')
        saved = { ...(req.body as object), staggerMinutes: 30, upcoming: [], queued: 0 };
      return ok({ dripQueue: saved });
    });
  }
  type Body = {
    schedule: Record<string, unknown>;
    slots: Array<{ weekday: number; time: string }>;
    enabled: boolean;
    platforms: string[];
  };

  it('saves "every day" with posts a day as the drip queue, turned on', async () => {
    const api = server();
    const user = userEvent.setup();
    renderScreen(<PostingPlanCard businessId="biz_1" />);
    expect(screen.getByRole('heading', { name: 'Plan your month' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Every day' })).toBeChecked();
    await user.selectOptions(screen.getByLabelText('Posts a day'), '2');
    expect(screen.getByText(/^2 posts a day · at 09:00 and 17:30 · /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save posting plan' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = api.find('PUT', QUEUE)[0]!.body as Body;
    expect(body.enabled).toBe(true);
    expect(body.platforms).toEqual([]);
    expect(body.schedule).toMatchObject({ mode: 'daily', postsPerDay: 2, timesMode: 'system' });
    expect(body.slots).toHaveLength(14);
    expect(
      await screen.findByText(/^Posting plan: 2 posts a day · at 09:00 and 17:30/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change the times in the calendar' })).toHaveAttribute(
      'href',
      '/calendar',
    );
  });

  it('offers N posts a week with the same choices', async () => {
    const api = server();
    const user = userEvent.setup();
    renderScreen(<PostingPlanCard businessId="biz_1" />);
    await user.click(screen.getByRole('radio', { name: 'Times a week' }));
    const count = screen.getByLabelText('Posts a week');
    expect(count).toHaveValue('3');
    expect(count.querySelectorAll('option')).toHaveLength(28);
    await user.selectOptions(count, '5');
    await user.click(screen.getByRole('button', { name: 'Save posting plan' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = api.find('PUT', QUEUE)[0]!.body as Body;
    expect(body.schedule).toMatchObject({ mode: 'weekly', postsPerWeek: 5, days: [1, 2, 3, 4, 5] });
    expect(body.slots.map((s) => `${s.weekday}@${s.time}`)).toEqual([
      '1@12:30',
      '2@12:30',
      '3@12:30',
      '4@12:30',
      '5@12:30',
    ]);
  });

  it('is part of the last onboarding step when a business is chosen', () => {
    mockFetch(() => ok({ dripQueue: null }));
    renderScreen(<CelebrateStep projectId={null} businessId="biz_1" />);
    expect(screen.getByRole('heading', { name: 'Almost there' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan your month' })).toBeInTheDocument();
  });
});
