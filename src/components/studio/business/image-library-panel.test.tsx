// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ImageLibraryPanel } from './image-library-panel';
import type { LibraryImage } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const image = (overrides: Partial<LibraryImage>): LibraryImage => ({
  id: 'img_1',
  businessId: 'biz_1',
  source: 'STOCK',
  sourceUrl: null,
  sourceProvider: 'pexels',
  publicUrl: null,
  previewUrl: 'https://cdn.example/img_1.jpg',
  hotlinked: false,
  widthPx: 1200,
  heightPx: 800,
  fileSizeBytes: 1000,
  tags: ['bread', 'oven'],
  altText: 'Fresh loaves',
  generatedFromPrompt: null,
  licenseNotes: null,
  useCount: 0,
  createdAt: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

describe('ImageLibraryPanel', () => {
  it('lists images and filters by source and tag', async () => {
    const api = mockFetch(() => ok({ data: [image({})], nextCursor: 'img_1' }));
    const user = userEvent.setup();
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    const grid = await screen.findByRole('list', { name: 'Image library' });
    expect(within(grid).getByRole('img', { name: 'Fresh loaves' })).toHaveAttribute(
      'src',
      'https://cdn.example/img_1.jpg',
    );
    await user.selectOptions(screen.getByLabelText('Source'), 'generated');
    await user.type(screen.getByLabelText('Tag'), 'bread');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const q = api.requests.at(-1)!.url.searchParams;
      expect(q.get('businessId')).toBe('biz_1');
      expect(q.get('source')).toBe('generated');
      expect(q.get('tag')).toBe('bread');
    });
    // The filtered page must have loaded (Older enabled on the NEW list) before paging; on a
    // loaded CI runner clicking the stale list's button was lost while the filter page loaded.
    const filteredRequests = api.requests.length;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Older' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(
      () => {
        expect(api.requests.length).toBeGreaterThan(filteredRequests);
        expect(api.requests.at(-1)!.url.searchParams.get('cursor')).toBe('img_1');
      },
      { timeout: 5_000 },
    );
  });

  it('shows empty and error states', async () => {
    mockFetch(() => ok({ data: [], nextCursor: null }));
    const { unmount } = renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    expect(await screen.findByText('Your image library is empty')).toBeInTheDocument();
    unmount();
    mockFetch(() => fail(500, 'Library down'));
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Library down');
  });

  it('20.16: credits stock providers on each stock tile and under the grid', async () => {
    mockFetch(() =>
      ok({
        data: [
          image({ id: 'img_p', sourceProvider: 'pixabay', altText: 'Pixabay loaf' }),
          image({ id: 'img_x', sourceProvider: 'pexels', altText: 'Pexels loaf' }),
          image({ id: 'img_u', source: 'UPLOAD', sourceProvider: null, altText: 'Own photo' }),
        ],
        nextCursor: null,
      }),
    );
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    const grid = await screen.findByRole('list', { name: 'Image library' });
    const tiles = within(grid).getAllByRole('listitem');
    expect(tiles[0]).toHaveTextContent('Images from Pixabay');
    expect(tiles[1]).toHaveTextContent('Images from Pexels');
    expect(tiles[2]).not.toHaveTextContent('Images from');
    expect(screen.getByText('Images from Pixabay and Pexels')).toBeInTheDocument();
  });

  it('shows no stock credit when no stock image is listed', async () => {
    mockFetch(() =>
      ok({ data: [image({ source: 'UPLOAD', sourceProvider: null })], nextCursor: null }),
    );
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    await screen.findByRole('list', { name: 'Image library' });
    expect(screen.queryByText(/Images from/)).toBeNull();
  });

  it('runs a semantic search and shows match scores', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ data: [image({ id: 'img_9', similarity: 0.87 })] })
        : ok({ data: [], nextCursor: null }),
    );
    const user = userEvent.setup();
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    await user.type(screen.getByLabelText('Search images by meaning'), 'warm bakery');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(results).toHaveTextContent('87% match');
    expect(api.find('POST', '/image-library/search')[0]!.body).toEqual({
      businessId: 'biz_1',
      query: 'warm bakery',
      limit: 24,
    });
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
  });

  it('uploads a file as multipart with the business id', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ duplicate: false, image: image({}) })
        : ok({ data: [], nextCursor: null }),
    );
    const user = userEvent.setup();
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    const file = new File(['png-bytes'], 'shop.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Image file to upload'), file);
    await waitFor(() => expect(api.find('POST', '/image-library')).toHaveLength(1));
    const form = api.find('POST', '/image-library')[0]!.body as FormData;
    expect(form.get('businessId')).toBe('biz_1');
    expect((form.get('file') as File).name).toBe('shop.png');
  });

  it('generates an image from a prompt', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST' ? ok({ image: image({}) }) : ok({ data: [], nextCursor: null }),
    );
    const user = userEvent.setup();
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Prompt'), 'Croissants on a marble counter');
    await user.selectOptions(within(dialog).getByLabelText('Shape'), '9:16');
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.find('POST', '/image-library/generate')).toHaveLength(1));
    expect(api.find('POST', '/image-library/generate')[0]!.body).toEqual({
      businessId: 'biz_1',
      prompt: 'Croissants on a marble counter',
      aspectRatio: '9:16',
    });
  });

  it('refreshes stock and deletes an image after confirmation', async () => {
    const { toast } = await import('sonner');
    const api = mockFetch((req) => {
      if (req.url.pathname.endsWith('/refresh')) return ok({ queued: true, queries: ['bread'] });
      if (req.method === 'DELETE') return ok({ deleted: true });
      return ok({ data: [image({})], nextCursor: null });
    });
    const user = userEvent.setup();
    renderScreen(<ImageLibraryPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'Refresh stock' }));
    await waitFor(() =>
      expect(api.find('POST', '/image-library/refresh')[0]!.body).toEqual({ businessId: 'biz_1' }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('1 query'));

    await user.click(screen.getByRole('button', { name: 'Delete image: Fresh loaves' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete image' }),
    );
    await waitFor(() => expect(api.find('DELETE', '/image-library/img_1')).toHaveLength(1));
  });
});
