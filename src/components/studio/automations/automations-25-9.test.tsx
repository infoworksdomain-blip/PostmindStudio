// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { AutomationDetailScreen } from './automation-detail';
import type { AutomationDetail, AutomationSummary } from './automation-model';
import { AutomationWizard } from './automation-wizard';
import { AutomationsList } from './automations-list';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/automations',
}));
vi.mock('../account/use-show-costs', () => ({ useShowCosts: () => false }));

// BACKLOG 25.9 — automations: a calm list with status and next post, the wizard's progress
// indicator, and the detail page's timeline of runs (latest open, older ones folded).

afterEach(() => vi.unstubAllGlobals());

function summary(id: string, patch: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id,
    businessId: 'biz_1',
    name: `Automation ${id}`,
    status: 'ACTIVE',
    cadence: { mode: 'per_day', postsPerDay: 1 },
    duration: 'ongoing_weekly',
    ongoing: true,
    platforms: ['tiktok'],
    targets: [],
    approvalMode: 'auto',
    periodIndex: 2,
    currentPlanId: 'plan_2',
    pauseReason: null,
    activatedAt: '2026-10-01T09:00:00.000Z',
    createdAt: '2026-10-01T09:00:00.000Z',
    ...patch,
  };
}

describe('AutomationsList (25.9)', () => {
  it('lists each automation with its status pill and next post, linking to its page', async () => {
    mockFetch(() =>
      ok({
        automations: [
          summary('a', { nextPostAt: '2030-10-10T08:00:00.000Z' }),
          summary('b', { status: 'PAUSED', nextPostAt: null }),
          summary('c', { status: 'REVIEW' }),
        ],
      }),
    );
    renderScreen(<AutomationsList />);
    const list = await screen.findByRole('list', { name: 'Automations' });
    const rows = within(list).getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/automations/a',
      '/automations/b',
      '/automations/c',
    ]);
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Thu 10 Oct/)).toHaveAttribute(
      'datetime',
      '2030-10-10T08:00:00.000Z',
    );
    expect(within(rows[1]!).getAllByText('Paused').length).toBeGreaterThan(0);
    expect(within(rows[2]!).getByText('After your review')).toBeInTheDocument();
  });
});

describe('AutomationWizard progress (25.9)', () => {
  it('says which step of five it is on and moves focus to each new step', async () => {
    mockFetch(() =>
      ok({
        data: [
          {
            id: 'conn-ig',
            platform: 'instagram',
            state: 'active',
            businessId: 'biz_1',
            platformAccountName: 'bakery',
          },
        ],
      }),
    );
    renderScreen(<AutomationWizard />);
    await screen.findByRole('heading', { name: 'Where should it post?' });
    const nav = screen.getByRole('navigation', { name: 'Steps' });
    expect(within(nav).getByText('Step 1 of 5')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Channels/ })).toHaveAttribute(
      'aria-current',
      'step',
    );
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(within(nav).getByText('Step 2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'How often?' })).toHaveFocus();
    expect(within(nav).getByRole('button', { name: /Channels/ })).toHaveTextContent('(done)');
  });
});

describe('AutomationDetailScreen runs (25.9)', () => {
  it('shows the runs as a timeline, the latest open with its posted count', async () => {
    const item = (id: string, status: string) => ({
      id,
      slotAt: '2030-10-10T08:00:00.000Z',
      kind: 'CAROUSEL',
      format: 'carousel',
      angle: 'how_to',
      angleId: null,
      title: `Slot ${id}`,
      slides: null,
      status,
      statusReason: null,
      projectId: null,
      reviewed: false,
      downloadOnly: [],
    });
    const period = (id: string, items: ReturnType<typeof item>[]) => ({
      id,
      status: 'SCHEDULED',
      startDate: '2030-10-07',
      days: 7,
      timezone: 'Europe/London',
      holdReason: null,
      cappedReason: null,
      items,
    });
    const body: AutomationDetail = {
      automation: { ...summary('aut-1'), insight: null },
      periods: [
        period('p2', [item('a', 'POSTED'), item('b', 'SCHEDULED')]),
        period('p1', [item('c', 'POSTED')]),
      ],
    };
    mockFetch(() => ok({ ...body }));
    renderScreen(<AutomationDetailScreen automationId="aut-1" />);
    const runs = await screen.findByRole('region', { name: 'Runs' });
    expect(within(runs).getByRole('heading', { name: 'Period 2' })).toBeInTheDocument();
    expect(within(runs).getByText(/1 of 2 posted/)).toBeInTheDocument();
    const details = runs.querySelectorAll('details');
    expect(details).toHaveLength(2);
    expect(details[0]).toHaveAttribute('open');
    expect(details[1]).not.toHaveAttribute('open');
  });
});
