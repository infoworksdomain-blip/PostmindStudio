// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { BusinessProvider } from './business-context';
import { BUSINESS_LIST_PENDING_HINT, BusinessSwitcher } from './business-picker';
import { mockFetch, renderWithSWR } from './library/test-helpers';

// BACKLOG 13.34: the header switcher is a picker when Core's list exists, a typed id until then.
// Phase 18 §2.11: in standalone mode the list is the organisation's own (local: true) and new
// businesses are added from the header.

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const renderSwitcher = (initial?: string) =>
  renderWithSWR(
    <BusinessProvider initial={initial}>
      <BusinessSwitcher />
    </BusinessProvider>,
  );

describe('BusinessSwitcher', () => {
  it('shows nothing while a standalone user has no organisation yet (no Core id box)', async () => {
    mockFetch([
      {
        match: '/api/studio/businesses',
        status: 403,
        body: {
          ok: false,
          error: 'no_organisation',
          message: 'Create or join an organisation first',
        },
      },
    ]);
    const { container } = renderSwitcher();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Business')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the typed business id and explains why while Core has no business list', async () => {
    mockFetch([
      {
        match: '/api/studio/businesses',
        status: 501,
        body: {
          ok: false,
          error: 'not_implemented',
          message:
            'waiting for Core list-businesses (GET /api/internal/organisations/:id/businesses)',
        },
      },
    ]);
    renderSwitcher('biz_old');
    const input = await screen.findByLabelText('Business');
    expect(input).toHaveAttribute('placeholder', 'biz_old');
    expect(await screen.findByText(BUSINESS_LIST_PENDING_HINT)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('offers Core’s businesses as a list once the endpoint answers', async () => {
    const user = userEvent.setup();
    mockFetch([
      {
        match: '/api/studio/businesses',
        body: {
          ok: true,
          data: [
            { id: 'biz_1', name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk' },
            { id: 'biz_2', name: 'Market stall' },
          ],
        },
      },
    ]);
    renderSwitcher('biz_1');
    const select = await screen.findByRole('combobox', { name: 'Business' });
    expect(select).toHaveValue('biz_1');
    expect(
      screen.getByRole('option', { name: 'Leeds Sourdough · leedssourdough.co.uk' }),
    ).toBeInTheDocument();
    await user.selectOptions(select, 'biz_2');
    expect(select).toHaveValue('biz_2');
    expect(window.localStorage.getItem('studio.businessId')).toBe('biz_2');
  });
});

describe('BusinessSwitcher — standalone businesses', () => {
  it('adds the first business inline, then selects it', async () => {
    const user = userEvent.setup();
    const list: Array<{ id: string; name: string }> = [];
    const { calls } = mockFetch([
      { match: '/api/studio/businesses', body: { ok: true, data: list, local: true } },
      {
        match: '/api/studio/businesses',
        method: 'POST',
        status: 201,
        body: { ok: true, business: { id: 'biz_new', name: 'Leeds Sourdough' } },
      },
    ]);
    renderSwitcher();
    await user.type(await screen.findByLabelText('New business'), 'Leeds Sourdough');
    list.push({ id: 'biz_new', name: 'Leeds Sourdough' });
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const select = await screen.findByRole('combobox', { name: 'Business' });
    expect(select).toHaveValue('biz_new');
    expect(window.localStorage.getItem('studio.businessId')).toBe('biz_new');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Leeds Sourdough' });
  });

  it('selects the first business when the stored one is not the organisation’s', async () => {
    mockFetch([
      {
        match: '/api/studio/businesses',
        body: { ok: true, data: [{ id: 'biz_1', name: 'One' }], local: true },
      },
    ]);
    renderSwitcher('someone-elses');
    const select = await screen.findByRole('combobox', { name: 'Business' });
    await vi.waitFor(() => expect(select).toHaveValue('biz_1'));
    expect(screen.getByRole('button', { name: 'Add a business' })).toBeInTheDocument();
  });

  it('offers no add button for Core’s list', async () => {
    mockFetch([
      {
        match: '/api/studio/businesses',
        body: { ok: true, data: [{ id: 'biz_1', name: 'One' }], local: false },
      },
    ]);
    renderSwitcher('biz_1');
    await screen.findByRole('combobox', { name: 'Business' });
    expect(screen.queryByRole('button', { name: 'Add a business' })).not.toBeInTheDocument();
  });

  it.each([
    ['ar', 'نشاط تجاري جديد'],
    ['zh-Hans', '新商家'],
  ] as const)('renders the add form in %s', async (locale, label) => {
    mockFetch([{ match: '/api/studio/businesses', body: { ok: true, data: [], local: true } }]);
    renderWithSWR(
      withLocale(
        locale,
        <BusinessProvider>
          <BusinessSwitcher />
        </BusinessProvider>,
      ),
    );
    expect(await screen.findByLabelText(label)).toBeInTheDocument();
  });

  it('drops a remembered business that is not in an organisation that has none', async () => {
    window.localStorage.setItem('studio.businessId', 'biz_of_another_organisation');
    mockFetch([{ match: '/api/studio/businesses', body: { ok: true, local: true, data: [] } }]);
    renderWithSWR(
      <BusinessProvider>
        <BusinessSwitcher />
      </BusinessProvider>,
    );
    await screen.findByLabelText('New business');
    await waitFor(() => expect(window.localStorage.getItem('studio.businessId')).toBeNull());
  });
});
