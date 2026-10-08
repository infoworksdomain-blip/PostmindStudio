// @vitest-environment jsdom
import { screen } from '@testing-library/react';
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
const can = vi.hoisted(() => ({ value: false }));
vi.mock('../use-can', () => ({ useCan: () => can.value }));

// BACKLOG 25.9 (audit): a read-only role sees why it cannot keep or skip, instead of buttons
// that are silently disabled; the keyboard shortcuts show as key caps.

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

afterEach(() => vi.unstubAllGlobals());

describe('BlitzScreen read-only and hints (25.9)', () => {
  it('explains that the role cannot keep or skip, and disables the deck buttons', async () => {
    can.value = false;
    mockFetch((req) =>
      req.url.pathname === '/api/studio/blitz' ? ok({ deck: deck([card('a')]) }) : undefined,
    );
    renderScreen(<BlitzScreen />);
    await screen.findByText('Card a');
    expect(
      screen.getByText(/Your role can look through these posts but can’t keep or skip them/),
    ).toBeInTheDocument();
    const keep = screen.getByRole('button', { name: 'Keep this post' });
    expect(keep).toBeDisabled();
    const actions = screen.getByRole('group', { name: 'Card actions' });
    expect(actions).toHaveAttribute('aria-describedby', 'blitz-disabled-reason');
  });

  it('shows the shortcuts as key caps and no notice for a member who can keep', async () => {
    can.value = true;
    mockFetch((req) =>
      req.url.pathname === '/api/studio/blitz' ? ok({ deck: deck([card('a')]) }) : undefined,
    );
    const { container } = renderScreen(<BlitzScreen />);
    await screen.findByText('Card a');
    expect(screen.queryByText(/Your role can look through/)).toBeNull();
    const keys = [...container.querySelectorAll('kbd')].map((k) => k.textContent);
    expect(keys).toEqual(['←', '↑', '→']);
    expect(screen.getByText(/Drag the card, or use → to keep/)).toHaveClass('sr-only');
  });
});
