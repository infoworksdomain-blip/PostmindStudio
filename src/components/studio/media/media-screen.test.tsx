// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { BusinessProvider } from '../business-context';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { MediaScreen } from './media-screen';
import { imageItem, uploadItem, videoItem } from './test-fixtures';

// BACKLOG 25.10 — My media: the unified grid, the segment in the URL, the business scope, paging,
// the preview dialog (player / image, download, open project) and the empty states.

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/media',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

const ALL = { data: [videoItem(), uploadItem(), imageItem()], nextCursor: null };

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    {
      match: /\/me(\?|$)/,
      body: { me: { capabilities: ['studio:project:read', 'studio:render:download'] } },
    },
    {
      match: /\/renders\/rnd_1\/preview$/,
      body: { ok: true, url: 'https://cdn.test/render.mp4', expiresInSec: 3600 },
    },
    {
      match: /\/renders\/rnd_1\/download$/,
      body: { ok: true, url: 'https://cdn.test/render-dl.mp4', expiresInSec: 900 },
    },
    { match: '/media', body: { ok: true, ...ALL } },
  ];
}

function renderScreen(initial = 'biz_1', ui = <MediaScreen />) {
  return renderWithSWR(<BusinessProvider initial={initial}>{ui}</BusinessProvider>);
}

beforeEach(() => {
  nav.search = '';
  nav.replace.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('MediaScreen', () => {
  it('shows renders, uploads and images as named tiles with type and status badges', async () => {
    const { calls } = mockFetch(routes());
    renderScreen();
    const video = await screen.findByRole('button', { name: 'Sourdough launch' });
    expect(within(video).getByText('21s')).toBeInTheDocument();
    expect(within(video).getByText('Approved')).toBeInTheDocument();
    const upload = screen.getByRole('button', { name: 'shop-tour.mp4' });
    expect(within(upload).getByText('Uploaded video')).toBeInTheDocument();
    const image = screen.getByRole('button', { name: 'Loaves on a rack' });
    expect(within(image).getByText('Uploaded')).toBeInTheDocument();
    expect(image).toHaveAccessibleDescription(/Image/);
    const req = calls.find((c) => c.url.includes('/media'));
    const params = new URL(req?.url ?? '', 'http://x').searchParams;
    expect(params.get('businessId')).toBe('biz_1');
    expect(params.get('type')).toBeNull();
    expect(params.get('limit')).toBe('24');
  });

  it('keeps the segment in the URL and asks the API for that type', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderScreen();
    await screen.findByRole('button', { name: 'Sourdough launch' });
    await user.click(screen.getByRole('radio', { name: 'Uploads' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/media?type=upload', { scroll: false });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/media') && c.url.includes('type=upload'))).toBe(
        true,
      ),
    );
    expect(screen.getByRole('radio', { name: 'Uploads' })).toHaveAttribute('aria-checked', 'true');
  });

  it('opens on the segment a link asks for', async () => {
    nav.search = 'type=image';
    const { calls } = mockFetch(routes());
    renderScreen();
    await screen.findByRole('button', { name: 'Sourdough launch' });
    expect(screen.getByRole('radio', { name: 'Images' })).toHaveAttribute('aria-checked', 'true');
    expect(calls.find((c) => c.url.includes('/media'))?.url).toContain('type=image');
  });

  it('plays a render in the preview dialog, downloads it and opens its project', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    mockFetch(routes());
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Sourdough launch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sourdough launch' });
    expect(await within(dialog).findByLabelText('Play Sourdough launch')).toHaveAttribute(
      'src',
      'https://cdn.test/render.mp4',
    );
    expect(within(dialog).getByText('1080 × 1920')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Open project/ })).toHaveAttribute(
      'href',
      '/projects/proj_1',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://cdn.test/render-dl.mp4', '_blank', 'noopener'),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sourdough launch' })).toHaveFocus();
  });

  it('shows an image whole with a download link and no project', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Loaves on a rack' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Loaves on a rack' })).toHaveAttribute(
      'src',
      'https://cdn.test/img.jpg',
    );
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      'https://cdn.test/img.jpg',
    );
    expect(within(dialog).queryByRole('link', { name: /Open project/ })).not.toBeInTheDocument();
  });

  it('plays an upload from its signed URL', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'shop-tour.mp4' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Play shop-tour.mp4')).toHaveAttribute(
      'src',
      'https://cdn.test/upload.mp4',
    );
  });

  it('pages with the cursor', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes([
        {
          match: 'cursor=c2',
          body: {
            ok: true,
            data: [imageItem({ id: 'img_9', altText: 'Page two' })],
            nextCursor: null,
          },
        },
        { match: '/media', body: { ok: true, data: [videoItem()], nextCursor: 'c2' } },
      ]),
    );
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    expect(await screen.findByRole('button', { name: 'Page two' })).toBeInTheDocument();
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('cursor=c2'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('button', { name: 'Sourdough launch' })).toBeInTheDocument();
  });

  it('lists every business when none is picked, and says so', async () => {
    const { calls } = mockFetch(routes());
    renderScreen('');
    await screen.findByRole('button', { name: 'Sourdough launch' });
    expect(screen.getByText(/Showing every business/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes('/media'))?.url).not.toContain('businessId');
  });

  it('points to where uploads happen when there is nothing yet', async () => {
    nav.search = 'type=upload';
    mockFetch(routes([{ match: '/media', body: { ok: true, data: [], nextCursor: null } }]));
    renderScreen();
    expect(await screen.findByText('No uploads yet')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Upload a video' });
    expect(links.every((l) => l.getAttribute('href') === '/new')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Add images' })[0]).toHaveAttribute(
      'href',
      '/business?tab=images',
    );
  });

  it('shows the error with a retry', async () => {
    mockFetch(
      routes([
        {
          match: '/media',
          status: 500,
          body: { ok: false, error: 'internal', message: 'Database down' },
        },
      ]),
    );
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database down');
  });

  it('renders in Arabic, right to left', async () => {
    mockFetch(routes());
    renderWithSWR(
      withLocale(
        'ar',
        <BusinessProvider initial="biz_1">
          <MediaScreen />
        </BusinessProvider>,
      ),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'وسائطي' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'المرفوعات' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });
});
