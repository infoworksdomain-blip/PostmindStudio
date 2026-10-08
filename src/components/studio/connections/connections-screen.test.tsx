// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import { render } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { withLocale } from '../../../../test/i18n-wrapper';
import { BusinessProvider } from '../business-context';
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

  it('shows when the daily check last confirmed access (17.3), not after an unreachable check', async () => {
    mockFetch(() =>
      ok({
        data: [
          conn({ statusCheckedAt: '2026-09-27T01:20:00.000Z', statusCheckOutcome: 'ok' }),
          conn({
            id: 'con_2',
            platform: 'youtube',
            platformAccountName: 'Bakery TV',
            statusCheckedAt: '2026-09-27T01:20:00.000Z',
            statusCheckOutcome: 'unreachable',
          }),
          conn({
            id: 'con_3',
            platform: 'instagram',
            businessId: null,
            platformAccountName: '@bakery.ig',
            statusCheckedAt: '2026-09-26T01:20:00.000Z',
            statusCheckOutcome: 'ok',
          }),
        ],
      }),
    );
    renderScreen(<ConnectionsScreen />);
    const tiktok = await screen.findByRole('region', { name: 'TikTok' });
    expect(within(tiktok).getByText(/^Access checked /)).toBeInTheDocument();
    const youtube = screen.getByRole('region', { name: 'YouTube' });
    expect(within(youtube).queryByText(/^Access checked /)).not.toBeInTheDocument();
    const instagram = screen.getByRole('region', { name: 'Instagram' });
    expect(within(instagram).getByText(/^Access checked /)).toBeInTheDocument();
  });

  it('lists Instagram / Facebook accounts registered by PostMind read-only, with guidance', async () => {
    mockFetch(() =>
      ok({
        data: [
          conn({
            id: 'con_ig',
            businessId: null,
            platform: 'instagram',
            platformAccountId: '17841400000000001',
            platformAccountName: '@bakery.ig',
          }),
          conn({
            id: 'con_fb',
            businessId: null,
            platform: 'facebook',
            platformAccountId: '100000000000001',
            platformAccountName: 'Bakery Page',
            state: 'needs_reconnect',
          }),
        ],
      }),
    );
    renderScreen(<ConnectionsScreen />);
    const instagram = await screen.findByRole('region', { name: 'Instagram' });
    expect(within(instagram).getByText('@bakery.ig')).toBeInTheDocument();
    expect(within(instagram).getByText('Connected')).toBeInTheDocument();
    expect(within(instagram).queryByRole('button')).not.toBeInTheDocument();
    // 25.12: Instagram and Facebook share one card with the guidance and no Connect button.
    const meta = screen.getByRole('region', { name: 'Instagram and Facebook' });
    expect(
      within(meta).getByText('Connect Instagram and Facebook in PostMind settings.'),
    ).toBeInTheDocument();
    expect(within(meta).queryByRole('button')).not.toBeInTheDocument();
    const facebook = screen.getByRole('region', { name: 'Facebook' });
    expect(within(facebook).getByText('Needs reconnecting')).toBeInTheDocument();
    expect(within(facebook).queryByRole('button')).not.toBeInTheDocument();
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
    const dialog = await screen.findByRole('alertdialog');
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

// Phase 18 §2.10 (Track D): standalone mode — Studio's own Meta login.
describe('ConnectionsScreen — Meta connect in standalone mode', () => {
  const studioMeta = { connect: 'studio', configured: true };

  it('offers Connect with Facebook and starts the Meta flow', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ authorizeUrl: 'https://www.facebook.com/v26.0/dialog/oauth?state=s' })
        : ok({ data: [], meta: studioMeta }),
    );
    const navigate = vi.fn();
    const user = userEvent.setup();
    renderScreen(<ConnectionsScreen navigate={navigate} />);
    const instagram = await screen.findByRole('region', { name: 'Instagram and Facebook' });
    expect(
      within(instagram).getByText(
        'One Facebook login connects the Pages you choose and the Instagram professional accounts linked to them.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Connect Instagram and Facebook in PostMind settings.')).toBeNull();
    await user.click(within(instagram).getByRole('button', { name: 'Connect with Facebook' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://www.facebook.com/v26.0/dialog/oauth?state=s'),
    );
    const [init] = api.find('POST', '/platform-connections/oauth-init');
    expect(init!.body).toMatchObject({ platform: 'meta', businessId: 'biz_1' });
  });

  it('lets a Studio-connected Page be disconnected here', async () => {
    const api = mockFetch((req) =>
      req.method === 'DELETE'
        ? ok({ disconnected: true })
        : ok({
            data: [
              conn({
                id: 'con_fb',
                platform: 'facebook',
                platformAccountId: '201',
                platformAccountName: 'Bakery Page',
                connectedVia: 'studio',
              }),
            ],
            meta: studioMeta,
          }),
    );
    const user = userEvent.setup();
    renderScreen(<ConnectionsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Disconnect Bakery Page' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.find('DELETE', '/platform-connections/con_fb')).toHaveLength(1));
  });

  it('says the Meta app is not set up yet instead of offering Connect', async () => {
    mockFetch(() => ok({ data: [], meta: { connect: 'studio', configured: false } }));
    renderScreen(<ConnectionsScreen />);
    const meta = await screen.findByRole('region', { name: 'Instagram and Facebook' });
    expect(within(meta).queryByRole('button')).toBeNull();
    expect(
      within(meta).getByText(/Studio’s Meta app still needs its settings/),
    ).toBeInTheDocument();
    const facebook = screen.getByRole('region', { name: 'Facebook' });
    expect(within(facebook).getByText('Not available')).toBeInTheDocument();
  });

  it('says a platform app is not set up yet instead of offering a Connect that fails', async () => {
    const api = mockFetch(() =>
      ok({
        data: [],
        meta: { connect: 'studio', configured: false },
        configured: { tiktok: false, youtube: true, x: true, linkedin: true },
      }),
    );
    renderScreen(<ConnectionsScreen />);
    const tiktok = await screen.findByRole('region', { name: 'TikTok' });
    expect(within(tiktok).queryByRole('button')).toBeNull();
    expect(
      within(tiktok).getByText(
        'TikTok is not available yet: Studio’s TikTok app still needs its settings. Ask your administrator.',
      ),
    ).toBeInTheDocument();
    const youtube = screen.getByRole('region', { name: 'YouTube' });
    expect(within(youtube).getByRole('button', { name: 'Connect YouTube' })).toBeEnabled();
    expect(api.find('POST', '/platform-connections/oauth-init')).toHaveLength(0);
  });

  it('reports ?connected=meta&count= and the Meta-specific callback errors', async () => {
    search = new URLSearchParams('connected=meta&count=2');
    mockFetch(() => ok({ data: [], meta: studioMeta }));
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      '2 Facebook and Instagram accounts are connected',
    );
  });

  it.each([
    ['meta_no_accounts', 'did not share any Facebook Page'],
    ['wrong_user', 'started by a different Studio user'],
  ])('explains ?connection_error=%s', async (code, text) => {
    search = new URLSearchParams(`connection_error=${code}`);
    mockFetch(() => ok({ data: [], meta: studioMeta }));
    renderScreen(<ConnectionsScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it.each([
    ['ar', 'الربط عبر Facebook'],
    ['zh-Hans', '使用 Facebook 连接'],
  ] as const)('renders in %s', async (locale, button) => {
    mockFetch(() => ok({ data: [], meta: studioMeta }));
    render(
      withLocale(
        locale,
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <BusinessProvider initial="biz_1">
            <ConnectionsScreen />
          </BusinessProvider>
        </SWRConfig>,
      ),
    );
    // 25.12: one Connect button on the shared Instagram and Facebook card.
    expect(await screen.findAllByRole('button', { name: button })).toHaveLength(1);
  });
});
