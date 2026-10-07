// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Publication } from '@/lib/client/types';
import type { PostPreview } from '@/lib/studio/services/post-preview';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { PostPanel, type PanelTarget } from './post-panel';

// 24.2 — the calendar side panel: preview, caption, networks, time, status and the existing
// actions; a dialog (Escape / close button), labelled by the post's name.

vi.mock('../preview/remotion-player', () => ({
  default: ({ label, aspect }: { label: string; aspect: string }) => (
    <div data-testid="remotion-player" data-aspect={aspect} aria-label={label} />
  ),
}));

const SCHEDULED_AT = '2026-10-08T09:00:00.000Z';

function publication(over: Partial<Publication> = {}): Publication {
  return {
    id: 'pub1',
    projectId: 'prj1',
    renderId: 'ren1',
    platform: 'instagram_reel',
    platformAccountId: 'acc',
    state: 'SCHEDULED',
    scheduledFor: '2099-10-08T09:00:00.000Z',
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    caption: null,
    hashtags: [],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    project: { id: 'prj1', name: 'Autumn menu' },
    ...over,
  };
}

function preview(over: Partial<PostPreview> = {}): PostPreview {
  return {
    projectId: 'prj1',
    name: 'Autumn menu',
    state: 'APPROVED',
    format: 'slideshow',
    aspectRatio: '4:5',
    caption: 'New autumn menu is here',
    hashtags: ['autumn', 'cafe'],
    platforms: ['instagram_reel', 'tiktok'],
    publications: [],
    scheduledFor: SCHEDULED_AT,
    live: {
      projectId: 'prj1',
      state: 'APPROVED',
      stage: 'ready',
      format: 'slideshow',
      progressPct: null,
      etaSec: null,
      startedAt: null,
      thumbnailUrl: null,
      at: '2026-10-06T10:00:00.000Z',
    },
    media: {
      kind: 'slides',
      rendered: false,
      slides: [{ imageUrl: null, text: 'Hook', durationSec: 3 }],
    },
    ...over,
  };
}

function setup(target: PanelTarget, data: PostPreview = preview()) {
  const api = mockFetch((req) => {
    if (req.url.pathname === '/api/studio/projects/prj1/preview') return ok({ preview: data });
    if (req.method === 'POST' && req.url.pathname.endsWith('/approve')) return ok({ project: {} });
    if (req.method === 'POST' && req.url.pathname.endsWith('/generate')) return ok({ project: {} });
    return undefined;
  });
  const handlers = { onClose: vi.fn(), onReschedule: vi.fn(), onChanged: vi.fn() };
  renderScreen(<PostPanel target={target} {...handlers} />);
  return { api, ...handlers };
}

afterEach(() => vi.unstubAllGlobals());

describe('PostPanel', () => {
  it('shows the preview, caption, networks, time and status of the post', async () => {
    setup({ kind: 'publication', publication: publication() });
    const panel = await screen.findByRole('dialog', { name: 'Autumn menu' });
    const player = await within(panel).findByTestId('remotion-player');
    expect(player).toHaveAttribute('data-aspect', '4:5');
    expect(player).toHaveAttribute('aria-label', 'Preview of the post (slides)');
    expect(within(panel).getByText('New autumn menu is here')).toBeInTheDocument();
    expect(within(panel).getByText('#autumn #cafe')).toBeInTheDocument();
    expect(within(panel).getByText('Instagram Reels, TikTok')).toBeInTheDocument();
    expect(within(panel).getByText('Scheduled')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Open project/ })).toHaveAttribute(
      'href',
      '/projects/prj1',
    );
  });

  it('reschedules through the calendar move dialog and closes with Escape', async () => {
    const user = userEvent.setup();
    const { onReschedule, onClose } = setup({ kind: 'publication', publication: publication() });
    const panel = await screen.findByRole('dialog', { name: 'Autumn menu' });
    await user.click(await within(panel).findByRole('button', { name: /Reschedule/ }));
    expect(onReschedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'pub1' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('approves a post waiting for review with the existing route', async () => {
    const user = userEvent.setup();
    const { api, onChanged } = setup(
      { kind: 'publication', publication: publication({ state: 'SCHEDULED' }) },
      preview({ state: 'READY_FOR_REVIEW' }),
    );
    const panel = await screen.findByRole('dialog');
    await user.click(await within(panel).findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.find('POST', '/projects/prj1/approve')).toHaveLength(1));
    expect(onChanged).toHaveBeenCalled();
  });

  it('regenerates a failed post and has an accessible close button', async () => {
    const user = userEvent.setup();
    const { api, onClose } = setup(
      { kind: 'publication', publication: publication({ state: 'FAILED' }) },
      preview({ state: 'FAILED', media: { kind: 'none' } }),
    );
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(/Nothing to preview yet/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(api.find('POST', '/projects/prj1/generate')).toHaveLength(1));
    expect(within(panel).queryByRole('button', { name: /Reschedule/ })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('opens a planned post that has a project, reading its preview', async () => {
    setup({
      kind: 'planned',
      post: {
        slotAt: SCHEDULED_AT,
        planId: 'plan1',
        itemId: 'item1',
        title: 'Autumn menu',
        kind: 'SLIDESHOW',
        status: 'GENERATING',
        projectId: 'prj1',
      },
    });
    expect(await screen.findByTestId('remotion-player')).toBeInTheDocument();
  });
});
