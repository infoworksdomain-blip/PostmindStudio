// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { BlitzScreen } from './blitz-screen';
import type { BlitzCard, BlitzDeck } from './blitz-model';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/blitz',
}));
vi.mock('../use-can', () => ({ useCan: () => true }));

// 22.4: the Blitz screen — deck, keep (choose how to post), skip with a reason (the nudge is
// announced), and the end-of-deck state.

const card = (id: string, over: Partial<BlitzCard> = {}): BlitzCard => ({
  id,
  format: 'carousel',
  tier: 'premade',
  angle: { id: 'ang', title: 'Weekend bakes' },
  title: `Card ${id}`,
  hook: 'Flat sourdough?',
  body: ['One', 'Two', 'Three'],
  cta: 'Order',
  hookType: 'mistake',
  caption: 'Flat sourdough?',
  whyItWorks: 'A mistake hook names a common problem.',
  mentionBusiness: false,
  slides: ['https://img.invalid/1.png', 'https://img.invalid/2.png'],
  videoUrl: null,
  posterUrl: null,
  previewImageUrl: null,
  remix: null,
  allowanceUnits: 1,
  createdAt: new Date().toISOString(),
  ...over,
});

const deck = (cards: BlitzCard[]): BlitzDeck => ({
  cards,
  rendering: 0,
  swipesToday: 0,
  swipesLeft: 60,
  caps: { rendersToday: 0, rendersLeftToday: 20, premadeAllowed: true },
  paused: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BlitzScreen', () => {
  it('keeps a card with "Schedule next free slot" by default', async () => {
    const api = mockFetch((req) => {
      if (req.url.pathname === '/api/studio/blitz')
        return ok({ deck: deck([card('a'), card('b')]) });
      if (req.method === 'POST' && req.url.pathname.endsWith('/decision'))
        return ok({
          result: {
            suggestionId: 'a',
            action: 'keep',
            projectId: 'prj-1',
            publish: 'scheduled',
            scheduledFor: null,
            downloadOnly: [],
            notice: null,
          },
        });
      return undefined;
    });
    renderScreen(<BlitzScreen />);
    await screen.findByText('Card a');
    expect(screen.getAllByText(/A mistake hook/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Keep this post' }));
    const option = await screen.findByRole('radio', { name: /Schedule next free slot/ });
    expect(option).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(api.find('POST', '/blitz/suggestions/a/decision')).toHaveLength(1));
    expect(api.find('POST', '/blitz/suggestions/a/decision')[0]?.body).toEqual({
      action: 'keep',
      mode: 'schedule',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Kept and scheduled.'));
  });

  it('22.7: the keep sheet says a TikTok copy goes to the TikTok drafts', async () => {
    mockFetch((req) => {
      if (req.url.pathname === '/api/studio/blitz') return ok({ deck: deck([card('a')]) });
      if (req.url.pathname === '/api/studio/platform-connections')
        return ok({
          data: [
            {
              id: 'con_tt',
              businessId: 'biz_1',
              platform: 'tiktok',
              platformAccountId: 'tt',
              platformAccountName: '@bakery',
              accessTokenExpiresAt: null,
              scopes: ['video.publish', 'video.upload'],
              state: 'active',
              connectedAt: '2026-10-06T10:00:00.000Z',
              tiktokPostMode: 'drafts',
            },
          ],
        });
      return undefined;
    });
    renderScreen(<BlitzScreen />);
    await screen.findByText('Card a');
    fireEvent.click(screen.getByRole('button', { name: 'Keep this post' }));
    expect(
      await screen.findByText(
        'TikTok: goes to your TikTok drafts. Add a trending sound in the app, then post.',
      ),
    ).toBeInTheDocument();
    // "Edit first" posts nothing, so the hint goes away.
    fireEvent.click(screen.getByRole('radio', { name: /Edit/ }));
    expect(screen.queryByText(/goes to your TikTok drafts/)).not.toBeInTheDocument();
  });

  it('skips with a reason and says what it learned', async () => {
    const api = mockFetch((req) => {
      if (req.url.pathname === '/api/studio/blitz')
        return ok({ deck: deck([card('a'), card('b')]) });
      if (req.method === 'POST')
        return ok({
          result: {
            suggestionId: 'a',
            action: 'skip',
            projectId: null,
            publish: null,
            scheduledFor: null,
            downloadOnly: [],
            notice: { kind: 'fewer_format', format: 'carousel' },
          },
        });
      return undefined;
    });
    renderScreen(<BlitzScreen />);
    await screen.findByText('Card a');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: 'Skip this post' }));
    act(() => vi.advanceTimersByTime(400));
    fireEvent.click(await screen.findByRole('button', { name: 'Not my style' }));
    await waitFor(() => expect(api.find('POST', '/blitz/suggestions/a/decision')).toHaveLength(1));
    expect(api.find('POST', '/blitz/suggestions/a/decision')[0]?.body).toEqual({
      action: 'skip',
      reason: 'not_my_style',
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('You’ll see fewer carousels.'));
  });

  it('shows the end of the deck and lets you ask for more', async () => {
    const api = mockFetch((req) => {
      if (req.url.pathname === '/api/studio/blitz') return ok({ deck: deck([]) });
      if (req.url.pathname === '/api/studio/blitz/refill') return ok({ queued: true });
      return undefined;
    });
    renderScreen(<BlitzScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate more' }));
    await waitFor(() => expect(api.find('POST', '/blitz/refill')).toHaveLength(1));
  });
});
