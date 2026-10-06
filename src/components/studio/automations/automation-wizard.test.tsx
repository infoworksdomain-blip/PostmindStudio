// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { AutomationWizard } from './automation-wizard';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/automations/new',
}));
vi.mock('../account/use-show-costs', () => ({ useShowCosts: () => false }));

// 22.5: the wizard — channels → cadence → mix → approval → summary (no pence for customers),
// then create (DRAFT) and start.

afterEach(() => vi.unstubAllGlobals());

describe('AutomationWizard', () => {
  it('walks the steps, shows the summary without costs, creates and starts', async () => {
    const api = mockFetch((req) => {
      const path = req.url.pathname;
      if (path === '/api/studio/platform-connections')
        return ok({
          data: [
            {
              id: 'conn-ig',
              platform: 'instagram',
              state: 'active',
              businessId: 'biz_1',
              platformAccountName: 'bakery',
            },
          ],
        });
      if (path === '/api/studio/automations/estimate')
        return ok({
          estimate: {
            posts: 7,
            periodDays: 7,
            ongoing: true,
            split: { carousel: 4, slideshow: 3 },
            paidPosts: 0,
            allowanceUnits: 7,
          },
        });
      if (path === '/api/studio/automations' && req.method === 'POST')
        return ok({ automation: { id: 'aut-1', status: 'DRAFT' } });
      if (path === '/api/studio/automations/aut-1/start')
        return ok({ automation: { id: 'aut-1' } });
      return undefined;
    });
    renderScreen(<AutomationWizard />);
    await screen.findByRole('heading', { name: 'Where should it post?' });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText('7 posts every 7 days')).toBeInTheDocument();
    expect(screen.getByText('Carousel: 4')).toBeInTheDocument();
    expect(screen.queryByText(/typical provider cost/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Create and start/ }));
    await waitFor(() => expect(api.find('POST', '/automations/aut-1/start')).toHaveLength(1));
    const body = api.find('POST', '/automations')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ approvalMode: 'review', duration: 'ongoing_weekly' });
    expect(push).toHaveBeenCalledWith('/automations/aut-1');
  });
});
