// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ConnectionsScreen } from './connections-screen';

// 22.7: members without studio:connections:manage do not see the TikTok posting setting.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../use-can', () => ({ useCan: () => false }));

afterEach(() => vi.unstubAllGlobals());

describe('TikTok posting preference for a viewer', () => {
  it('hides the setting and names the account once', async () => {
    mockFetch(() =>
      ok({
        data: [
          {
            id: 'con_1',
            businessId: 'biz_1',
            platform: 'tiktok',
            platformAccountId: 'tt_1',
            platformAccountName: '@bakery',
            accessTokenExpiresAt: null,
            scopes: ['video.upload'],
            state: 'active',
            connectedAt: '2026-09-01T10:00:00.000Z',
            tiktokPostMode: 'drafts',
          },
        ],
      }),
    );
    renderScreen(<ConnectionsScreen />);
    const tiktok = await screen.findByRole('region', { name: 'TikTok' });
    expect(within(tiktok).getAllByText('@bakery')).toHaveLength(1);
    expect(within(tiktok).queryByRole('radio')).not.toBeInTheDocument();
  });
});
