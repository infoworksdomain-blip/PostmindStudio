// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ConnectionsScreen } from './connections-screen';

const replace = vi.fn();
const router = { replace };
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => search,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function conn(overrides: Partial<PlatformConnection>): PlatformConnection {
  return {
    id: 'con_1',
    businessId: 'biz_1',
    platform: 'tiktok',
    platformAccountId: 'tt_1',
    platformAccountName: '@bakery',
    accessTokenExpiresAt: null,
    scopes: [],
    state: 'active',
    connectedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  search = new URLSearchParams();
  replace.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('ConnectionsScreen', () => {
  it('asks for a business when none is selected', async () => {
    mockFetch(() => ok({ data: [] }));
    renderScreen(<ConnectionsScreen />, null);
    expect(await screen.findByText('Pick a business first')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading connections')).not.toBeInTheDocument();
  });

  it("lists this business's accounts, hides revoked and other businesses, flags needs_reconnect", async () => {
    mockFetch(() =>
      ok({
        data: [
          conn({}),
          conn({
            id: 'con_2',
            platform: 'youtube',
            platformAccountName: 'Bakery TV',
            state: 'needs_reconnect',
          }),
          conn({ id: 'con_3', platform: 'x', platformAccountName: '@old', state: 'revoked' }),
          conn({
            id: 'con_4',
            platform: 'linkedin',
            platformAccountName: 'Other biz',
            businessId: 'biz_2',
          }),
        ],
      }),
    );
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByText('@bakery')).toBeInTheDocument();
    const youtube = screen.getByRole('region', { name: 'YouTube' });
    expect(within(youtube).getByText('Needs reconnecting')).toBeInTheDocument();
    expect(within(youtube).getByRole('button', { name: /Reconnect/ })).toBeInTheDocument();
    expect(screen.queryByText('@old')).not.toBeInTheDocument();
    expect(screen.queryByText('Other biz')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect X' })).toBeInTheDocument();
  });

  it('starts OAuth and sends the browser to the authorize URL', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ authorizeUrl: 'https://linkedin.example/auth?state=s' })
        : ok({ data: [] }),
    );
    const navigate = vi.fn();
    const user = userEvent.setup();
    renderScreen(<ConnectionsScreen navigate={navigate} />);
    await user.click(await screen.findByRole('button', { name: 'Connect LinkedIn' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://linkedin.example/auth?state=s'),
    );
    const [init] = api.find('POST', '/platform-connections/oauth-init');
    expect(init!.body).toEqual({
      platform: 'linkedin',
      businessId: 'biz_1',
      returnTo: `${window.location.origin}/connections`,
    });
    expect(init!.headers['idempotency-key']).toBeTruthy();
  });

  it('shows an error toast and stays put when oauth-init fails', async () => {
    const { toast } = await import('sonner');
    mockFetch((req) =>
      req.method === 'POST' ? fail(500, 'TikTok is not configured') : ok({ data: [] }),
    );
    const navigate = vi.fn();
    const user = userEvent.setup();
    renderScreen(<ConnectionsScreen navigate={navigate} />);
    await user.click(await screen.findByRole('button', { name: 'Connect TikTok' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('TikTok is not configured'));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect TikTok' })).toBeEnabled();
  });

  it('disconnects after confirmation', async () => {
    const api = mockFetch((req) =>
      req.method === 'DELETE' ? ok({ disconnected: true }) : ok({ data: [conn({})] }),
    );
    const user = userEvent.setup();
    renderScreen(<ConnectionsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Disconnect @bakery' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.find('DELETE', '/platform-connections/con_1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.find('DELETE', '/platform-connections/con_1')).toHaveLength(1));
  });

  it('reports ?connected= from the OAuth callback and clears the query', async () => {
    search = new URLSearchParams('connected=youtube');
    mockFetch(() => ok({ data: [] }));
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByRole('status')).toHaveTextContent('YouTube is connected');
    expect(replace).toHaveBeenCalledWith('/connections', { scroll: false });
  });

  it('reports ?connection_error= from the OAuth callback', async () => {
    search = new URLSearchParams('connection_error=validation_error');
    mockFetch(() => ok({ data: [] }));
    const user = userEvent.setup();
    renderScreen(<ConnectionsScreen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('did not grant access');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error state', async () => {
    mockFetch(() => fail(403, 'nope'));
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('permission');
  });
});
