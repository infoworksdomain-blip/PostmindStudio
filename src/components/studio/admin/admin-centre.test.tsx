// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forbidden, mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { AdminCentre } from './admin-centre';
import { GLOBAL_CONFIRM_PHRASE } from './kill-switch-panel';
import type { KillSwitchState } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const running: KillSwitchState = {
  ok: true,
  global: { enabled: false, since: null },
  frozenWorkspaces: [{ id: 'org_frozen', since: '2026-09-26T10:00:00.000Z' }],
  killedProjects: [],
  disabledProviders: [{ id: 'runway', since: '2026-09-25T10:00:00.000Z' }],
  disabledPlatforms: [{ id: 'tiktok', since: '2026-09-27T09:00:00.000Z' }],
  propagationSec: 30,
};

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    {
      match: '/admin/kill-switch',
      method: 'PUT',
      body: { ok: true, flag: { key: 'k', value: 'true' } },
    },
    { match: '/admin/kill-switch', body: running },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  nav.search = '';
});

describe('AdminCentre access', () => {
  it('shows the staff-only state on 403', async () => {
    mockFetch([{ match: '/admin/kill-switch', status: 403, body: forbidden }]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByText('PostMind staff only')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('tells staff without 2FA to turn it on, with a link to account security', async () => {
    mockFetch([
      { match: '/admin/kill-switch', status: 403, body: forbidden },
      {
        match: '/me',
        body: {
          ok: true,
          me: {
            user: { id: 'u1', name: 'Ops', email: null, platformRole: 'superadmin' },
            organisation: { id: 'o1', name: 'Org', role: 'owner' },
            organisations: [],
            plan: null,
            banner: null,
            impersonating: false,
            identityMode: 'standalone',
            capabilities: [],
          },
        },
      },
    ]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByText('Turn on two-factor authentication')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up two-factor authentication' })).toHaveAttribute(
      'href',
      '/account/security',
    );
    expect(screen.queryByText('PostMind staff only')).not.toBeInTheDocument();
  });

  it('shows an error (not the staff state) for other failures', async () => {
    mockFetch([
      {
        match: '/admin/kill-switch',
        status: 500,
        body: { ok: false, error: 'internal', message: 'Flags unavailable' },
      },
    ]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Flags unavailable');
    expect(screen.queryByText('PostMind staff only')).not.toBeInTheDocument();
  });
});

describe('AdminCentre section menu (25.13)', () => {
  const sectionRoutes = () =>
    routes([
      { match: '/library/categories', body: { ok: true, data: [] } },
      { match: '/library/videos', body: { ok: true, data: [], nextCursor: null } },
      { match: '/admin/cost', body: { ok: true, days: 30, data: [] } },
      { match: '/admin/subscriptions', body: { ok: true, total: 0, byStatus: {}, data: [] } },
    ]);

  it('groups every section under Operations, Content, Customers and Platform', async () => {
    mockFetch(sectionRoutes());
    renderWithSWR(<AdminCentre />);
    const menu = await screen.findByRole('navigation', { name: 'Admin sections' });
    const group = (name: string) =>
      within(within(menu).getByRole('list', { name }))
        .getAllByRole('link')
        .map((l) => l.textContent);
    expect(group('Operations')).toEqual([
      'Kill switch',
      'Queues',
      'Dead letters',
      'Re-drive',
      'Providers',
    ]);
    expect(group('Content')).toEqual([
      'Library',
      'Safety review',
      'Safety audit',
      'Force-approvals',
    ]);
    expect(group('Customers')).toEqual([
      'Organisations',
      'Users',
      'Subscriptions & billing',
      'Plan usage',
      'Beta',
    ]);
    expect(group('Platform')).toEqual(['Features', 'Cost report']);
    expect(within(menu).getByRole('link', { name: 'Kill switch' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('opens a section from the menu and writes ?tab= with replace', async () => {
    const user = userEvent.setup();
    mockFetch(sectionRoutes());
    renderWithSWR(<AdminCentre />);
    const menu = await screen.findByRole('navigation', { name: 'Admin sections' });
    const library = within(menu).getByRole('link', { name: 'Library' });
    expect(library).toHaveAttribute('href', '/admin?tab=library');
    await user.click(library);
    expect(await screen.findByText('Add to the corpus')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Library' })).toBeInTheDocument();
    expect(nav.replace).toHaveBeenLastCalledWith('/admin?tab=library', { scroll: false });
    expect(within(menu).getByRole('link', { name: 'Library' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(menu).getByRole('link', { name: 'Cost report' }));
    expect(await screen.findByText('No provider usage in this window.')).toBeInTheDocument();
    expect(nav.replace).toHaveBeenLastCalledWith('/admin?tab=cost', { scroll: false });
  });

  it('jumps to a section from the phone picker', async () => {
    const user = userEvent.setup();
    mockFetch(sectionRoutes());
    renderWithSWR(<AdminCentre />);
    const jump = await screen.findByLabelText('Go to section');
    expect(within(jump).getByRole('group', { name: 'Platform' })).toBeInTheDocument();
    await user.selectOptions(jump, 'cost');
    expect(await screen.findByText('No provider usage in this window.')).toBeInTheDocument();
    expect(nav.replace).toHaveBeenLastCalledWith('/admin?tab=cost', { scroll: false });
  });

  it('follows ?tab= after load, not only on the first render', async () => {
    mockFetch(sectionRoutes());
    nav.search = 'tab=library';
    const view = renderWithSWR(<AdminCentre />);
    expect(await screen.findByText('Add to the corpus')).toBeInTheDocument();
    nav.search = 'tab=cost';
    act(() => view.rerender(<AdminCentre />));
    expect(await screen.findByText('No provider usage in this window.')).toBeInTheDocument();
  });

  it('opens the old ?tab=subscriptions link on the Stripe records of Subscriptions & billing', async () => {
    const user = userEvent.setup();
    mockFetch(sectionRoutes());
    nav.search = 'tab=subscriptions';
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('region', { name: 'Subscriptions & billing' })).toBeVisible();
    const views = screen.getByRole('radiogroup', { name: 'View' });
    expect(within(views).getByRole('radio', { name: 'Stripe records' })).toBeChecked();
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    await user.click(within(views).getByRole('radio', { name: 'Entitlement overrides' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/admin?tab=billing&view=entitlements', {
      scroll: false,
    });
    expect(await screen.findByLabelText('Organisation id')).toBeInTheDocument();
  });

  it('marks the kill switch item Halted while the global switch is engaged', async () => {
    mockFetch([
      {
        match: '/admin/kill-switch',
        body: { ...running, global: { enabled: true, since: '2026-09-27T08:00:00.000Z' } },
      },
    ]);
    renderWithSWR(<AdminCentre />);
    const menu = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(menu).getByRole('link', { name: /Kill switch/ })).toHaveTextContent('Halted');
  });
});

describe('Kill switch tab', () => {
  it('lists active scoped switches', async () => {
    mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('heading', { name: 'Studio is running' })).toBeInTheDocument();
    expect(screen.getByText('org_frozen', { selector: 'span.font-mono' })).toBeInTheDocument();
    expect(screen.getByText('runway', { selector: 'span.font-mono' })).toBeInTheDocument();
    expect(screen.getByText('No projects killed.')).toBeInTheDocument();
  });

  it('requires a reason and the typed phrase before halting Studio', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('button', { name: 'Engage global kill switch' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Halt Studio' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Reason/), 'Provider incident');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'halt all studio');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/to confirm/));
    await user.type(within(dialog).getByLabelText(/to confirm/), GLOBAL_CONFIRM_PHRASE);
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ level: 'global', enabled: true, reason: 'Provider incident' });
    expect(put?.headers['idempotency-key']).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('releases the global switch without a typed phrase', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/kill-switch', method: 'PUT', body: { ok: true, flag: {} } },
      {
        match: '/admin/kill-switch',
        body: { ...running, global: { enabled: true, since: '2026-09-27T08:00:00.000Z' } },
      },
    ]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('heading', { name: 'Studio is halted' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Release global kill switch' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'All clear');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'global',
        enabled: false,
        reason: 'All clear',
      }),
    );
  });

  it('releases a scoped switch', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('button', { name: 'Release runway' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Recovered');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'provider',
        target: 'runway',
        enabled: false,
        reason: 'Recovered',
      }),
    );
  });

  it('engages a provider switch from the scoped form', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    const form = await screen.findByRole('form', { name: 'Engage a scoped kill switch' });
    const engage = within(form).getByRole('button', { name: 'Engage' });
    expect(engage).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Level'), 'provider');
    await user.selectOptions(within(form).getByLabelText('Provider'), 'luma');
    await user.type(within(form).getByLabelText('Reason'), 'Latency spike');
    await user.click(engage);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'provider',
        target: 'luma',
        enabled: true,
        reason: 'Latency spike',
      }),
    );
  });

  it('lists halted platforms and releases one', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByText('Halted platforms')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Release tiktok' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Re-drive tab/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Appeal won');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'platform',
        target: 'tiktok',
        enabled: false,
        reason: 'Appeal won',
      }),
    );
  });

  it('halts publishing to one platform from the scoped form', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    const form = await screen.findByRole('form', { name: 'Engage a scoped kill switch' });
    await user.selectOptions(within(form).getByLabelText('Level'), 'platform');
    const target = within(form).getByLabelText('Platform');
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('youtube_short');
    await user.selectOptions(target, 'x');
    await user.type(within(form).getByLabelText('Reason'), 'X API outage');
    await user.click(within(form).getByRole('button', { name: 'Engage' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'platform',
        target: 'x',
        enabled: true,
        reason: 'X API outage',
      }),
    );
  });

  it('keeps the dialog open and reports when the PUT fails', async () => {
    const user = userEvent.setup();
    const { toast } = await import('sonner');
    mockFetch([
      {
        match: '/admin/kill-switch',
        method: 'PUT',
        status: 400,
        body: { ok: false, error: 'validation_error', message: 'Unknown providerId' },
      },
      { match: '/admin/kill-switch', body: running },
    ]);
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('button', { name: 'Release org_frozen' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Try it');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unknown providerId'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
