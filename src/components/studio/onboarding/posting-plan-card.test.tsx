// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { CelebrateStep } from './celebrate-step';
import { PostingPlanCard } from './posting-plan-card';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const QUEUE = '/businesses/biz_1/drip-queue';

describe('PostingPlanCard (20.3)', () => {
  it('one click saves a posting plan as the drip queue, turned on', async () => {
    let saved: unknown = null;
    const api = mockFetch((req) => {
      if (!req.url.pathname.endsWith('/drip-queue')) return undefined;
      if (req.method === 'PUT') saved = { ...(req.body as object), staggerMinutes: 30 };
      return ok({ dripQueue: saved });
    });
    const user = userEvent.setup();
    renderScreen(<PostingPlanCard businessId="biz_1" />);
    expect(screen.getByRole('heading', { name: 'Plan your month' })).toBeInTheDocument();
    const plans = screen.getByRole('group', { name: 'Quick posting plans' });
    await user.click(within(plans).getByRole('button', { name: '3 a week' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = api.find('PUT', QUEUE)[0]!.body as {
      slots: Array<{ weekday: number; time: string }>;
      enabled: boolean;
      platforms: string[];
    };
    expect(body.enabled).toBe(true);
    expect(body.platforms).toEqual([]);
    expect(body.slots.map((s) => `${s.weekday}@${s.time}`)).toEqual([
      '1@12:30',
      '3@12:30',
      '5@12:30',
    ]);
    expect(await screen.findByText('Posting plan: 3 a week.')).toBeInTheDocument();
    expect(within(plans).getByRole('button', { name: '3 a week' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Change the times in the calendar' })).toHaveAttribute(
      'href',
      '/calendar',
    );
  });

  it('is part of the last onboarding step when a business is chosen', () => {
    mockFetch(() => ok({ dripQueue: null }));
    renderScreen(<CelebrateStep projectId={null} businessId="biz_1" />);
    expect(screen.getByRole('heading', { name: 'Almost there' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan your month' })).toBeInTheDocument();
  });
});
