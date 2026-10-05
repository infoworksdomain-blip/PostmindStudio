// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { CarouselEditor } from './carousel-editor';
import type { CarouselView } from './model';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const view = (over: Partial<CarouselView> = {}): CarouselView => ({
  projectId: 'p1',
  state: 'READY_FOR_REVIEW',
  editable: true,
  canRerender: true,
  rewritesLeft: 30,
  carousel: {
    theme: 'light',
    language: 'en-GB',
    profile: { displayName: 'Acme Bakery', handle: 'acmebakery', logoUploadId: null },
    posts: [
      {
        id: 'a',
        text: '3 bread tips:',
        image: { imageId: 'img1', width: 10, height: 10, aiGenerated: false },
      },
      { id: 'b', text: '→ rest the dough longer\n→ weigh', image: null },
      { id: 'c', text: 'Follow for more', image: null },
    ],
    postCount: 3,
    aiWritten: true,
  },
  images: { img1: 'https://signed/img1.jpg' },
  render: {
    id: 'r1',
    qualityCheckState: 'PASSED',
    createdAt: '2026-10-04T10:00:00Z',
    aiGenerated: true,
    issues: [],
    slides: [
      { index: 0, pngUrl: 'https://signed/s1.png', postIds: ['a'] },
      { index: 1, pngUrl: 'https://signed/s2.png', postIds: ['b', 'c'] },
    ],
  },
  ...over,
});

const preview = {
  ok: true,
  preview: {
    slides: [
      { index: 0, kind: 'single', postIds: ['a'], image: 'data:image/jpeg;base64,AAA' },
      { index: 1, kind: 'pair', postIds: ['b', 'c'], image: 'data:image/jpeg;base64,BBB' },
    ],
    issues: [{ slide: 1, code: 'low_contrast', detail: 'x' }],
    removedCharacters: 2,
  },
};

function routes(v: CarouselView = view(), extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/projects/p1/carousel', body: { ok: true, carousel: v } },
    { method: 'POST', match: '/projects/p1/carousel/preview', body: preview },
    { method: 'PUT', match: '/projects/p1/carousel', body: { ok: true, carousel: v } },
    { method: 'POST', match: '/projects/p1/carousel/render', status: 202, body: { ok: true } },
    { method: 'POST', match: '/projects/p1/carousel/rewrite', body: { ok: true, carousel: v } },
    {
      method: 'POST',
      match: '/projects/p1/carousel/download',
      body: { ok: true, url: 'https://signed/all.zip', fileName: 'c.zip' },
    },
  ];
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const renderEditor = (onChanged = vi.fn()) =>
  renderWithSWR(
    <CarouselEditor
      projectId="p1"
      projectState="READY_FOR_REVIEW"
      businessId="biz_1"
      onChanged={onChanged}
    />,
  );

describe('CarouselEditor', () => {
  it('shows each post with its role and slides, and the live preview with its notes', async () => {
    mockFetch(routes());
    renderEditor();
    expect(await screen.findByLabelText(/Post 1/)).toHaveValue('3 bread tips:');
    expect(screen.getByText(/Hook/)).toBeInTheDocument();
    expect(screen.getByText(/Call to action/)).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Slide 1 of 2' })).toBeInTheDocument();
    expect(screen.getByText(/2 emoji or symbols aren’t shown/)).toBeInTheDocument();
    expect(screen.getByText('Slide 2: text is hard to read')).toBeInTheDocument();
    expect(screen.getByText(/labelled as AI-generated/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Slide 2' })).toHaveAttribute(
      'href',
      'https://signed/s2.png',
    );
  });

  it('previews and saves edited text, order, look and handle', async () => {
    const api = mockFetch(routes());
    renderEditor();
    const hook = await screen.findByLabelText(/Post 1/);
    await userEvent.clear(hook);
    await userEvent.type(hook, 'New hook');
    await userEvent.click(screen.getByRole('button', { name: 'Move post 3 up' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await userEvent.clear(screen.getByLabelText('Handle'));
    await userEvent.type(screen.getByLabelText('Handle'), 'acme');
    await waitFor(
      () => {
        const last = api.find('POST', '/projects/p1/carousel/preview').at(-1);
        expect((last?.body as { posts: Array<{ text: string }> }).posts[0]?.text).toBe('New hook');
      },
      { timeout: 4_000 },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/projects/p1/carousel')).toHaveLength(1));
    expect(api.find('PUT', '/projects/p1/carousel')[0]?.body).toEqual({
      theme: 'dark',
      profile: { displayName: 'Acme Bakery', handle: 'acme' },
      posts: [
        { id: 'a', text: 'New hook', imageId: 'img1' },
        { id: 'c', text: 'Follow for more', imageId: null },
        { id: 'b', text: '→ rest the dough longer\n→ weigh', imageId: null },
      ],
    });
    expect(toast.success).toHaveBeenCalledWith('Carousel saved.');
  });

  it('sorts a list shortest first, removes a picture and rewrites one post with AI', async () => {
    const api = mockFetch(routes());
    renderEditor();
    await screen.findByLabelText(/Post 2/);
    await userEvent.click(screen.getByRole('button', { name: 'Shortest line first' }));
    expect(screen.getByLabelText(/Post 2/)).toHaveValue('→ weigh\n→ rest the dough longer');
    await userEvent.click(screen.getByRole('button', { name: 'Remove picture' }));
    expect(screen.queryByRole('button', { name: 'Remove picture' })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Rewrite with AI' })[2]!);
    // The unsaved picture change is saved first, then post c is rewritten.
    await waitFor(() => expect(api.find('POST', '/projects/p1/carousel/rewrite')).toHaveLength(1));
    expect(api.find('PUT', '/projects/p1/carousel')).toHaveLength(1);
    expect(api.find('POST', '/projects/p1/carousel/rewrite')[0]?.body).toEqual({ postId: 'c' });
  });

  it('renders again and downloads every slide', async () => {
    const onChanged = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const api = mockFetch(routes());
    renderEditor(onChanged);
    await userEvent.click(await screen.findByRole('button', { name: 'Render again' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/projects/p1/carousel/render')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Download all slides (ZIP)' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://signed/all.zip', '_blank', 'noopener'),
    );
  });

  it('is read-only while the carousel cannot be edited', async () => {
    mockFetch(routes(view({ editable: false, canRerender: false, state: 'APPROVED' })));
    renderEditor();
    expect(await screen.findByText(/can’t be edited right now/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Post 1/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Render again' })).not.toBeInTheDocument();
  });
});
