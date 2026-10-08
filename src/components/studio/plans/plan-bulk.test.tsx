// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { runSequential } from './bulk-run';
import { approvableItems, groupByWeek, planPreview, type Plan, type PlanItem } from './plan-model';
import { PlanScreen } from './plan-screen';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/plans' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// BACKLOG 25.9 — the month plan as a week-by-week timeline, the planner's preview, and the bulk
// actions built on the per-item routes (one call per post, in order, with progress and a summary).

const DAY = 86_400_000;

function item(n: number, patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id: `item_${n}`,
    position: n,
    slotAt: new Date(Date.UTC(2026, 9, 1 + n * 2, 9, 0)).toISOString(),
    kind: 'VIDEO',
    angle: 'how_to',
    title: `Topic ${n}`,
    brief: `Brief ${n}`,
    slides: null,
    calendarDay: null,
    status: 'PLANNED',
    statusReason: null,
    projectId: null,
    ...patch,
  };
}

function plan(items: PlanItem[], patch: Partial<Plan> = {}): Plan {
  const counts = Object.fromEntries(
    [
      'PLANNED',
      'QUEUED',
      'GENERATING',
      'READY',
      'SCHEDULED',
      'POSTED',
      'HELD',
      'FAILED',
      'SKIPPED',
      'REMOVED',
    ].map((s) => [s, items.filter((i) => i.status === s).length]),
  ) as Plan['counts'];
  return {
    id: 'plan_1',
    businessId: 'biz_1',
    status: 'DRAFT',
    startDate: '2026-10-01',
    days: 14,
    timezone: 'Europe/London',
    windowStart: '2026-09-30T23:00:00.000Z',
    windowEnd: '2026-10-14T23:00:00.000Z',
    postsPerDay: 1,
    useDripSlots: false,
    videoShare: 100,
    platforms: ['tiktok'],
    requestedCount: items.length,
    cappedReason: null,
    holdReason: null,
    draftError: null,
    createdAt: '2026-09-30T10:00:00.000Z',
    scheduledAt: null,
    cancelledAt: null,
    counts,
    estimate: { typicalPence: 0, maxPence: 0 },
    items,
    ...patch,
  };
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('plan helpers (25.9)', () => {
  it('groups a plan by its own weeks, starting on its first day', () => {
    const weeks = groupByWeek([item(0), item(1), item(3), item(4)], 'Europe/London', '2026-10-01');
    // Days 1, 3 and 7 are the plan's first week; day 9 its second.
    expect(weeks.map((w) => [w.index, w.start, w.end, w.days.length])).toEqual([
      [1, '2026-10-01', '2026-10-07', 3],
      [2, '2026-10-09', '2026-10-09', 1],
    ]);
  });

  it('previews the posts, the split and an even spread over the days', () => {
    const p = planPreview(
      { startDate: '2026-10-01', days: 30, postsPerDay: 2, useDripSlots: false, videoShare: 25 },
      0,
    );
    expect([p.count, p.videos, p.slideshows, p.endDate]).toEqual([60, 15, 45, '2026-10-30']);
    expect(p.perDay.every((n) => n === 2)).toBe(true);
    const drip = planPreview(
      { startDate: '2026-10-01', days: 7, postsPerDay: 1, useDripSlots: true, videoShare: 50 },
      3,
    );
    expect(drip.count).toBe(3);
    expect(drip.perDay.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('only posts waiting for review with a project can be approved', () => {
    expect(
      approvableItems([
        item(0, { status: 'READY', projectId: 'p0' }),
        item(1, { status: 'READY' }),
        item(2, { status: 'SCHEDULED', projectId: 'p2' }),
      ]).map((i) => i.id),
    ).toEqual(['item_0']);
  });

  it('runs a bulk step one item at a time and carries on after a failure', async () => {
    const order: number[] = [];
    const progress: Array<[number, number]> = [];
    const result = await runSequential(
      [1, 2, 3],
      async (n) => {
        order.push(n);
        if (n === 2) throw new Error('no');
      },
      (p) => progress.push([p.done, p.failed]),
    );
    expect(order).toEqual([1, 2, 3]);
    expect(result.ok).toEqual([1, 3]);
    expect(result.failed.map((f) => f.item)).toEqual([2]);
    expect(progress).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
  });
});

describe('PlanScreen timeline and bulk actions (25.9)', () => {
  it('shows the draft week by week and asks for new topics for the selected posts', async () => {
    const items = [item(0), item(1), item(4)];
    const api = mockFetch((req) => {
      if (req.url.pathname.endsWith('/item_1/regenerate'))
        return { status: 409, body: { ok: false, error: 'conflict', message: 'busy' } };
      return ok({ plan: plan(items) });
    });
    const user = userEvent.setup();
    renderScreen(<PlanScreen planId="plan_1" />);
    const timeline = await screen.findByRole('list', { name: 'Posts by day' });
    expect(within(timeline).getByRole('heading', { name: /Week 1/ })).toBeInTheDocument();
    expect(within(timeline).getByRole('heading', { name: /Week 2/ })).toBeInTheDocument();
    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    await user.click(screen.getByRole('checkbox', { name: 'Select “Topic 0”' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select “Topic 1”' }));
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'New topics (2)' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.find('POST', '/content-plans/plan_1/items/item_0/regenerate')).toHaveLength(1);
    expect(api.find('POST', '/content-plans/plan_1/items/item_1/regenerate')).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith(
      '1 done, 1 could not be changed. Try those one by one.',
    );
    // The failed one stays selected so it can be tried again.
    expect(screen.getByRole('checkbox', { name: 'Select “Topic 1”' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select “Topic 0”' })).not.toBeChecked();
  });

  it('deletes every selected post after one confirmation', async () => {
    const items = [item(0), item(1)];
    const api = mockFetch(() => ok({ plan: plan(items) }));
    const user = userEvent.setup();
    renderScreen(<PlanScreen planId="plan_1" />);
    const bar = await screen.findByRole('group', { name: 'Bulk actions' });
    await user.click(within(bar).getByRole('checkbox'));
    await user.click(within(bar).getByRole('button', { name: 'Delete (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete the selected posts (2)?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete (2)' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Done: 2 changed.'));
    expect(api.find('DELETE', '/content-plans/plan_1/items/item_0')).toHaveLength(1);
    expect(api.find('DELETE', '/content-plans/plan_1/items/item_1')).toHaveLength(1);
  });

  it('approves one waiting post, or all of them, with the review screen’s route', async () => {
    const soon = Date.now() + 5 * DAY;
    const items = [
      item(0, { status: 'READY', projectId: 'prj_0', slotAt: new Date(soon).toISOString() }),
      item(1, { status: 'READY', projectId: 'prj_1', slotAt: new Date(soon + DAY).toISOString() }),
      item(2, {
        status: 'SCHEDULED',
        projectId: 'prj_2',
        slotAt: new Date(soon + 2 * DAY).toISOString(),
      }),
    ];
    const api = mockFetch(() =>
      ok({
        plan: plan(items, {
          status: 'SCHEDULED',
          startDate: new Date(soon).toISOString().slice(0, 10),
        }),
      }),
    );
    const user = userEvent.setup();
    renderScreen(<PlanScreen planId="plan_1" />);
    await user.click(await screen.findByRole('button', { name: 'Approve “Topic 0”' }));
    await waitFor(() => expect(api.find('POST', '/projects/prj_0/approve')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Approve “Topic 2”' })).toBeNull();
    expect(
      screen.getByText(/Studio makes each post about 3 days before its time/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve all waiting (2)' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Done: 2 changed.'));
    expect(api.find('POST', '/projects/prj_0/approve')).toHaveLength(2);
    expect(api.find('POST', '/projects/prj_1/approve')).toHaveLength(1);
  });
});
