// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import type { Plan, PlanDefaults, PlanItem } from './plan-model';
import { PlanMonthForm } from './plan-month-form';
import { PlanScreen } from './plan-screen';
import { PlansList } from './plans-list';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/plans' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// 20.9 — the month-plan screens: the form (defaults, slider, accounts, validation, POST body),
// drafting progress, the draft editor (edit, reorder, delete, generate with confirmation) and
// the plan view (statuses, held notice, remove in the review window, cancel), plus RTL.

const DEFAULTS: PlanDefaults = {
  timezone: 'Europe/London',
  startDate: '2026-10-01',
  days: 30,
  maxDays: 31,
  postsPerDay: 1,
  maxPostsPerDay: 4,
  hasPostingTimes: false,
  postingTimesPerWeek: 0,
  videoShare: 50,
  planTier: 'STANDARD',
  allowance: { mode: 'enforce', limit: 40, used: 10, credits: 5, remaining: 35 },
  cost: { capPence: 7_300, spentPence: 500, creditHeadroomPence: 175 },
  typicalCostPence: { VIDEO: 160, SLIDESHOW: 150 },
};

const CONNECTION = {
  id: 'conn_tt',
  businessId: 'biz_1',
  platform: 'tiktok',
  platformAccountId: 'tt1',
  platformAccountName: 'Leeds Sourdough',
  accessTokenExpiresAt: null,
  scopes: [],
  state: 'active',
  connectedAt: '2026-09-01T00:00:00.000Z',
};

function item(n: number, patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id: `item_${n}`,
    position: n,
    slotAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(n / 2), n % 2 ? 16 : 8, 0)).toISOString(),
    kind: n % 2 ? 'VIDEO' : 'SLIDESHOW',
    angle: n === 3 ? 'seasonal' : 'how_to',
    title: `Topic ${n}`,
    brief: `Brief ${n}`,
    slides: { hook: 'Hook', points: ['One', 'Two'], cta: 'Order' },
    calendarDay: n === 3 ? 'halloween' : null,
    status: 'PLANNED',
    statusReason: null,
    projectId: null,
    ...patch,
  };
}

function plan(patch: Partial<Plan> = {}): Plan {
  const items = patch.items ?? [item(0), item(1), item(2), item(3)];
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
    days: 2,
    timezone: 'Europe/London',
    windowStart: '2026-09-30T23:00:00.000Z',
    windowEnd: '2026-10-02T23:00:00.000Z',
    postsPerDay: 2,
    useDripSlots: false,
    videoShare: 50,
    platforms: ['tiktok'],
    requestedCount: 4,
    cappedReason: null,
    holdReason: null,
    draftError: null,
    createdAt: '2026-09-30T10:00:00.000Z',
    scheduledAt: null,
    cancelledAt: null,
    counts,
    estimate: { typicalPence: 620, maxPence: 1_000 },
    items,
    ...patch,
  };
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('PlanMonthForm', () => {
  it('starts from the defaults, shows the allowance and posts the plan', async () => {
    const api = mockFetch((req) => {
      if (req.url.pathname.endsWith('/content-plans/defaults')) return ok({ defaults: DEFAULTS });
      if (req.url.pathname.endsWith('/platform-connections')) return ok({ data: [CONNECTION] });
      if (req.method === 'POST') return { status: 202, body: { ok: true, plan: plan() } };
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen(<PlanMonthForm />);
    const start = await screen.findByLabelText('Start date');
    expect(start).toHaveValue('2026-10-01');
    expect(screen.getByText(/30 videos left of 40/)).toBeInTheDocument();
    expect(screen.getByText(/plus 5 top-up credits/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Use my posting times' })).toBeDisabled();
    expect(screen.getByText('Up to 30 posts over 30 days.')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: '2 a day' }));
    expect(screen.getByText('Up to 60 posts over 30 days.')).toBeInTheDocument();
    const slider = screen.getByLabelText('Videos and slideshows');
    expect(slider).toHaveAttribute('aria-valuetext', '50% videos · 50% slideshows');

    // The only TikTok account is picked already.
    expect(screen.getByLabelText('TikTok account')).toHaveValue('conn_tt');
    await user.click(screen.getByRole('button', { name: 'Draft my month' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/plans/plan_1'));
    expect(api.find('POST', '/content-plans')[0]!.body).toMatchObject({
      businessId: 'biz_1',
      startDate: '2026-10-01',
      days: 30,
      postsPerDay: 2,
      videoShare: 50,
      platforms: ['tiktok'],
      targets: [{ platform: 'tiktok', connectionId: 'conn_tt' }],
      timezone: 'Europe/London',
    });
  });

  it('20.12: with no connected account it says so and drafts a plan saved for review', async () => {
    const api = mockFetch((req) => {
      if (req.url.pathname.endsWith('/content-plans/defaults')) return ok({ defaults: DEFAULTS });
      if (req.url.pathname.endsWith('/platform-connections')) return ok({ data: [] });
      if (req.method === 'POST') return { status: 202, body: { ok: true, plan: plan() } };
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen(<PlanMonthForm />);
    expect(
      await screen.findByText(
        /No connected accounts: the posts are made and saved for your review/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/connections',
    );
    expect(screen.queryByLabelText('TikTok account')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Draft my month' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/plans/plan_1'));
    expect(api.find('POST', '/content-plans')[0]!.body).toMatchObject({
      platforms: ['tiktok'],
      targets: [],
    });
  });

  it('20.12: asks for the account when a platform has several, and names uncovered ones', async () => {
    const second = { ...CONNECTION, id: 'conn_tt_2', platformAccountName: 'Second TikTok' };
    const api = mockFetch((req) => {
      if (req.url.pathname.endsWith('/content-plans/defaults')) return ok({ defaults: DEFAULTS });
      if (req.url.pathname.endsWith('/platform-connections'))
        return ok({ data: [CONNECTION, second] });
      if (req.method === 'POST') return { status: 202, body: { ok: true, plan: plan() } };
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen(<PlanMonthForm />);
    const select = await screen.findByLabelText('TikTok account');
    expect(select).toHaveValue('');
    await user.click(screen.getByLabelText('X'));
    expect(
      screen.getByText('Made but not posted automatically (no connected account): X.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Draft my month' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose the account each platform posts to.',
    );
    expect(api.find('POST', '/content-plans')).toHaveLength(0);
    await user.selectOptions(select, 'conn_tt_2');
    await user.click(screen.getByRole('button', { name: 'Draft my month' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/plans/plan_1'));
    expect(api.find('POST', '/content-plans')[0]!.body).toMatchObject({
      platforms: ['tiktok', 'x'],
      targets: [{ platform: 'tiktok', connectionId: 'conn_tt_2' }],
    });
  });
});

describe('PlanScreen', () => {
  it('shows drafting progress while Claude writes', async () => {
    mockFetch(() =>
      ok({
        plan: plan({ status: 'DRAFTING', items: [item(0), item(1, { title: '' })] }),
      }),
    );
    renderScreen(<PlanScreen planId="plan_1" />);
    expect(await screen.findByRole('heading', { name: /Drafting your month/ })).toBeInTheDocument();
    expect(screen.getByText('1 of 2 posts written')).toBeInTheDocument();
  });

  it('edits, reorders, deletes and generates a draft (after asking once)', async () => {
    const api = mockFetch((req) => {
      if (req.method === 'GET') return ok({ plan: plan() });
      return ok({ plan: plan() });
    });
    const user = userEvent.setup();
    renderScreen(<PlanScreen planId="plan_1" />);
    expect(
      await screen.findByRole('heading', { name: '4 posts: 2 videos and 2 slideshows' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Halloween')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move “Topic 1” later' }));
    await waitFor(() => expect(api.find('POST', '/content-plans/plan_1/reorder')).toHaveLength(1));
    expect(api.find('POST', '/content-plans/plan_1/reorder')[0]!.body).toEqual({
      itemIds: ['item_0', 'item_2', 'item_1', 'item_3'],
    });

    await user.click(screen.getByRole('button', { name: 'Delete “Topic 2”' }));
    await waitFor(() =>
      expect(api.find('DELETE', '/content-plans/plan_1/items/item_2')).toHaveLength(1),
    );

    const row = screen.getByText('Topic 0').closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const topic = within(row).getByLabelText('Topic');
    await user.clear(topic);
    await user.type(topic, 'Rye starter');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.find('PATCH', '/content-plans/plan_1/items/item_0')[0]!.body).toMatchObject({
        title: 'Rye starter',
        kind: 'SLIDESHOW',
        slides: { points: ['One', 'Two'] },
      }),
    );

    await user.click(screen.getByRole('button', { name: /Generate and schedule/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Generate and schedule 4 posts?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Generate and schedule' }));
    await waitFor(() => expect(api.find('POST', '/content-plans/plan_1/generate')).toHaveLength(1));
  });

  it('20.12: a plan with no account says its posts are saved for review before generating', async () => {
    mockFetch(() => ok({ plan: plan({ targets: [] }) }));
    const user = userEvent.setup();
    renderScreen(<PlanScreen planId="plan_1" />);
    expect(
      await screen.findByText(/This plan has no connected account, so each post is made and saved/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Generate and schedule/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Nothing is posted automatically because the plan has no connected/),
    ).toBeInTheDocument();
  });

  it('shows statuses, the held note and removes a scheduled post before its time', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000);
    const at = (h: number) => new Date(future.getTime() + h * 3_600_000).toISOString();
    const items = [
      item(0, { status: 'SCHEDULED', projectId: 'prj_0', slotAt: at(0) }),
      item(1, {
        status: 'HELD',
        projectId: 'prj_1',
        slotAt: at(1),
        statusReason: 'content_safety_flag',
      }),
      item(2, { status: 'POSTED', projectId: 'prj_2', slotAt: at(2) }),
    ];
    const api = mockFetch(() => ok({ plan: plan({ status: 'SCHEDULED', items }) }));
    const user = userEvent.setup();
    renderScreen(<PlanScreen planId="plan_1" />);
    const stats = await screen.findByRole('group', { name: 'Posts by status' });
    expect(within(stats).getByText('Held by the safety check')).toBeInTheDocument();
    expect(screen.getByText(/1 post was held by the safety check/)).toBeInTheDocument();
    expect(screen.getByText('The content safety check flagged it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open “Topic 0”' })).toHaveAttribute(
      'href',
      '/projects/prj_0',
    );
    // A posted item can no longer be removed.
    expect(screen.queryByRole('button', { name: 'Remove “Topic 2”' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove “Topic 0”' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(api.find('DELETE', '/content-plans/plan_1/items/item_0')).toHaveLength(1),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel plan' }));
    const cancel = await screen.findByRole('dialog');
    await user.click(within(cancel).getByRole('button', { name: 'Cancel plan' }));
    await waitFor(() => expect(api.find('POST', '/content-plans/plan_1/cancel')).toHaveLength(1));
  });

  it('renders right-to-left in Arabic', async () => {
    mockFetch(() => ok({ plan: plan() }));
    renderScreen(withLocale('ar', <PlanScreen planId="plan_1" />));
    expect(await screen.findByRole('button', { name: /أنتِج وجدوِل/ })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('PlansList', () => {
  it('lists the business plans with their status', async () => {
    const { items: _items, ...summary } = plan({ status: 'SCHEDULED' });
    void _items;
    mockFetch(() => ok({ data: [summary] }));
    renderScreen(<PlansList />);
    const link = await screen.findByRole('link', { name: /4 posts/ });
    expect(link).toHaveAttribute('href', '/plans/plan_1');
    expect(within(link).getByText('Scheduled')).toBeInTheDocument();
  });
});
