// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConnection } from '@/lib/client/types';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ConnectionsScreen } from './connections-screen';
import { postModeOf, TikTokDraftsHint, uploadGranted } from './tiktok-post-mode';

// 22.7 — the TikTok card's posting preference and the "Goes to your TikTok drafts" hint.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BOTH = ['user.info.basic', 'video.publish', 'video.upload'];

function conn(overrides: Partial<PlatformConnection>): PlatformConnection {
  return {
    id: 'con_1',
    businessId: 'biz_1',
    platform: 'tiktok',
    platformAccountId: 'tt_1',
    platformAccountName: '@bakery',
    accessTokenExpiresAt: null,
    scopes: BOTH,
    state: 'active',
    connectedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('postModeOf / uploadGranted', () => {
  it('treats only "drafts" as drafts (null = a connection from before 22.7 = direct)', () => {
    expect(postModeOf({ tiktokPostMode: 'drafts' })).toBe('drafts');
    expect(postModeOf({ tiktokPostMode: 'direct' })).toBe('direct');
    expect(postModeOf({ tiktokPostMode: null })).toBe('direct');
    expect(postModeOf({})).toBe('direct');
    expect(uploadGranted({ scopes: BOTH })).toBe(true);
    expect(uploadGranted({ scopes: ['video.publish'] })).toBe(false);
  });
});

describe('TikTok posting preference on the Connections screen', () => {
  it('shows drafts selected, the trending-sound note, and saves "Post directly"', async () => {
    let mode: 'drafts' | 'direct' = 'drafts';
    const api = mockFetch((req) => {
      if (req.method === 'PATCH') {
        mode = (req.body as { tiktokPostMode: 'drafts' | 'direct' }).tiktokPostMode;
        return ok({ connection: conn({ tiktokPostMode: mode }), uploadGranted: true });
      }
      return ok({
        data: [conn({ tiktokPostMode: mode }), conn({ id: 'con_yt', platform: 'youtube' })],
      });
    });
    renderScreen(<ConnectionsScreen />);
    const tiktok = await screen.findByRole('region', { name: 'TikTok' });
    const drafts = within(tiktok).getByRole('radio', { name: /Send to TikTok drafts/ });
    const direct = within(tiktok).getByRole('radio', { name: /Post directly/ });
    expect(drafts).toBeChecked();
    expect(direct).not.toBeChecked();
    expect(
      within(tiktok).getByText('TikTok drafts let you add a trending sound before posting.'),
    ).toBeInTheDocument();
    expect(within(tiktok).queryByRole('alert')).not.toBeInTheDocument();
    // Only TikTok has the setting.
    const youtube = screen.getByRole('region', { name: 'YouTube' });
    expect(within(youtube).queryByRole('radio')).not.toBeInTheDocument();

    await userEvent.click(direct);
    await waitFor(() => expect(api.find('PATCH', '/platform-connections/con_1')).toHaveLength(1));
    expect(api.find('PATCH', '/platform-connections/con_1')[0]?.body).toEqual({
      tiktokPostMode: 'direct',
    });
    await waitFor(() =>
      expect(within(tiktok).getByRole('radio', { name: /Post directly/ })).toBeChecked(),
    );
  });

  it('shows "Post directly" for a connection from before 22.7 (no preference stored)', async () => {
    mockFetch(() => ok({ data: [conn({ tiktokPostMode: null })] }));
    renderScreen(<ConnectionsScreen />);
    const tiktok = await screen.findByRole('region', { name: 'TikTok' });
    expect(within(tiktok).getByRole('radio', { name: /Post directly/ })).toBeChecked();
  });

  it('asks for a reconnect when drafts are chosen without the upload permission', async () => {
    mockFetch(() => ok({ data: [conn({ tiktokPostMode: 'drafts', scopes: ['video.publish'] })] }));
    renderScreen(<ConnectionsScreen />);
    const tiktok = await screen.findByRole('region', { name: 'TikTok' });
    expect(within(tiktok).getByRole('alert')).toHaveTextContent(
      'Reconnect TikTok to send drafts. Until then, posts go out directly.',
    );
  });
});

describe('TikTokDraftsHint', () => {
  it('says the post goes to the TikTok drafts when the business account sends drafts', async () => {
    mockFetch(() => ok({ data: [conn({ tiktokPostMode: 'drafts' })] }));
    renderScreen(<TikTokDraftsHint businessId="biz_1" />);
    expect(
      await screen.findByText(
        'TikTok: goes to your TikTok drafts. Add a trending sound in the app, then post.',
      ),
    ).toBeInTheDocument();
  });

  it('shows nothing for direct posting, another business or a revoked account', async () => {
    const api = mockFetch(() =>
      ok({
        data: [
          conn({ tiktokPostMode: 'direct' }),
          conn({ id: 'c2', tiktokPostMode: 'drafts', businessId: 'biz_2' }),
          conn({ id: 'c3', tiktokPostMode: 'drafts', state: 'revoked' }),
        ],
      }),
    );
    const { container } = renderScreen(<TikTokDraftsHint businessId="biz_1" />);
    await waitFor(() => expect(api.requests.length).toBeGreaterThan(0));
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
