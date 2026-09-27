// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessProvider } from './business-context';
import { BUSINESS_LIST_PENDING_HINT, BusinessSwitcher } from './business-picker';
import { mockFetch, renderWithSWR } from './library/test-helpers';

// BACKLOG 13.34: the header switcher is a picker when Core's list exists, a typed id until then.

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
