// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { ACCOUNT_BANNER_ID } from '../account/account-banners';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { NoticeStrip, noticeKinds } from './notice-strip';

// BACKLOG 25.4 — one notice strip: the most urgent notice, the rest behind "n more".

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse('2026-10-01T12:00:00Z');

function me(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    me: {
      user: { id: 'u1', name: 'Ada Baker', email: 'ada@example.test', platformRole: 'user' },
      organisation: { id: 'o1', name: 'Crumb & Co', role: 'owner' },
      organisations: [{ id: 'o1', name: 'Crumb & Co', role: 'owner' }],
      plan: null,
      banner: null,
      impersonating: false,
      identityMode: 'standalone',
      capabilities: [],
      ...over,
    },
  };
}

function usage(status: 'ok' | 'warning' | 'exceeded') {
  return {
    usage: {
      organisationId: 'o1',
      planTier: 'STANDARD',
      mode: 'enforce',
      month: '2026-10',
      periodStart: '2026-10-01T00:00:00Z',
      resetsAt: '2026-11-01T00:00:00Z',
      thresholds: [80, 100],
      status,
      videos: {
        short: { used: 9, limit: 10, percent: 90, maxDurationSec: 60 },
        long: { used: 0, limit: 0, percent: 0, maxDurationSec: null },
      },
      platforms: { rule: 'all', description: '' },
      scans: { businessesScanned: 0, limit: 1 },
    },
  };
}

describe('noticeKinds', () => {
  it('orders the notices by urgency', () => {
    expect(
      noticeKinds({
        banner: { kind: 'trial', endsAt: '2026-10-05T00:00:00Z' },
        usageStatus: 'warning',
        impersonating: true,
      }),
    ).toEqual(['impersonating', 'usage_warning', 'trial']);
    expect(
      noticeKinds({ banner: { kind: 'past_due', graceUntil: null }, usageStatus: 'exceeded' }),
    ).toEqual(['usage_exceeded', 'past_due']);
    expect(noticeKinds({ banner: { kind: 'read_only' }, usageStatus: 'warning' })).toEqual([
      'read_only',
      'usage_warning',
    ]);
    expect(noticeKinds({ usageStatus: 'ok' })).toEqual([]);
  });
});

describe('NoticeStrip', () => {
  it('renders nothing when all is well', async () => {
    const api = mockFetch([
      { match: '/api/studio/me', body: me() },
      { match: '/api/studio/usage', body: usage('ok') },
    ]);
    const { container } = renderWithSWR(withLocale('en-GB', <NoticeStrip now={NOW} />));
    await vi.waitFor(() => expect(api.calls.length).toBe(2));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the most urgent notice and discloses the others', async () => {
    mockFetch([
      {
        match: '/api/studio/me',
        body: me({ banner: { kind: 'past_due', graceUntil: null } }),
      },
      { match: '/api/studio/usage', body: usage('warning') },
    ]);
    const user = userEvent.setup();
    renderWithSWR(withLocale('en-GB', <NoticeStrip now={NOW} />));
    const region = await screen.findByRole('region', { name: 'Account notices' });
    expect(region).toHaveTextContent('Your last payment failed.');
    // The usage warning waits behind the disclosure, still in the document.
    const more = screen.getByRole('button', { name: '1 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/close to this month’s Standard plan limit/)).not.toBeVisible();
    // The billing banner keeps its id (a disabled create button points at it).
    expect(document.getElementById(ACCOUNT_BANNER_ID)).toHaveTextContent('payment failed');
    await user.click(more);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/close to this month’s Standard plan limit/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Update payment' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });

  it('puts an exceeded allowance first, with its actions', async () => {
    mockFetch([
      {
        match: '/api/studio/me',
        body: me({ banner: { kind: 'trial', endsAt: '2026-10-04T12:00:00Z' } }),
      },
      { match: '/api/studio/usage', body: usage('exceeded') },
    ]);
    renderWithSWR(withLocale('en-GB', <NoticeStrip now={NOW} />));
    const region = await screen.findByRole('region', { name: 'Account notices' });
    await vi.waitFor(() =>
      expect(region).toHaveTextContent('You’ve used this month’s Standard plan videos'),
    );
    expect(screen.getByRole('button', { name: '1 more' })).toBeInTheDocument();
  });
});
