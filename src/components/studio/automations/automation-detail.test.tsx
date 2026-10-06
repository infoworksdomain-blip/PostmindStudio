// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { AutomationDetailScreen } from './automation-detail';
import type { AutomationDetail, AutomationSlot } from './automation-model';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/automations/aut-1',
}));

// 23.6 rolling generation: a queued slot Studio creates later says when; others keep the status.

afterEach(() => vi.unstubAllGlobals());

const slotAt = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function slot(id: string, patch: Partial<AutomationSlot> = {}): AutomationSlot {
  return {
    id,
    slotAt: slotAt(5),
    kind: 'CAROUSEL',
    format: 'carousel',
    angle: 'how_to',
    angleId: null,
    title: `Slot ${id}`,
    slides: null,
    status: 'QUEUED',
    statusReason: null,
    projectId: null,
    reviewed: false,
    downloadOnly: [],
    ...patch,
  };
}

function detail(items: AutomationSlot[]): AutomationDetail {
  return {
    automation: {
      id: 'aut-1',
      businessId: 'biz_1',
      name: 'Weekly bakes',
      status: 'ACTIVE',
      cadence: { mode: 'per_day', postsPerDay: 1 },
      duration: 'ongoing_weekly',
      ongoing: true,
      platforms: ['instagram'],
      targets: [{ platform: 'instagram', connectionId: 'conn-ig' }],
      approvalMode: 'auto',
      periodIndex: 1,
      currentPlanId: 'plan_1',
      pauseReason: null,
      activatedAt: '2026-10-01T09:00:00.000Z',
      createdAt: '2026-10-01T09:00:00.000Z',
      insight: null,
    },
    periods: [
      {
        id: 'plan_1',
        status: 'GENERATING',
        startDate: '2026-10-01',
        days: 7,
        timezone: 'Europe/London',
        holdReason: null,
        cappedReason: null,
        items,
      },
    ],
  };
}

describe('AutomationDetailScreen', () => {
  it('23.6: shows "Scheduled to be created on" only for queued slots made later', async () => {
    // 08:00 UTC on 10 Oct 2030 is 09:00 in London (BST).
    const createsAt = '2030-10-10T08:00:00.000Z';
    const items = [
      slot('a', { createsAt }),
      slot('b', { createsAt: null, slotAt: slotAt(6) }),
      slot('c', { createsAt: '2020-01-01T00:00:00.000Z', slotAt: slotAt(7) }),
      slot('d', { status: 'GENERATING', createsAt, slotAt: slotAt(8) }),
    ];
    mockFetch((req) =>
      req.url.pathname === '/api/studio/automations/aut-1' ? ok({ ...detail(items) }) : undefined,
    );
    renderScreen(<AutomationDetailScreen automationId="aut-1" />);
    const title = await screen.findByText('Slot a');
    const labels = screen.getAllByText(/^Scheduled to be created on /);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveTextContent('Scheduled to be created on Thu 10 Oct, 9:00');
    expect(within(title.closest('li')!).getByText(/^Scheduled to be created on /)).toBe(labels[0]);
    // The others keep their plain status.
    expect(screen.getAllByText('Waiting to be made')).toHaveLength(3);
    expect(screen.getByText('Being made')).toBeInTheDocument();
  });
});
