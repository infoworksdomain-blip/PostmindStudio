// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeUpgrade, type UpgradeEvent } from '@/lib/client/upgrade-events';
import type { LibraryImage } from '../business/types';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { ImageStudioScreen } from './image-studio-screen';

// BACKLOG 25.8 — Image Studio: prompt-first generation, the generated images, preview with
// download and "Generate again", and the plan-locked / switched-off states.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/images',
  useSearchParams: () => new URLSearchParams(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const generated = (id: string, over: Partial<LibraryImage> = {}): LibraryImage => ({
  id,
  businessId: 'biz_1',
  source: 'GENERATED',
  sourceUrl: null,
  sourceProvider: 'dalle-3',
  publicUrl: null,
  previewUrl: `https://cdn.test/${id}.png`,
  hotlinked: false,
  widthPx: 1024,
  heightPx: 1024,
  fileSizeBytes: 100_000,
  tags: [],
  altText: `Prompt for ${id}`,
  generatedFromPrompt: `Prompt for ${id}\nStyle: warm film`,
  licenseNotes: null,
  useCount: 0,
  createdAt: '2026-10-07T10:00:00.000Z',
  ...over,
});

const usage = (planTier: string): MockRoute => ({
  match: '/usage',
  body: { ok: true, usage: { planTier } },
});
const list = (data: LibraryImage[]): MockRoute => ({
  match: '/image-library',
  body: { ok: true, data, nextCursor: null },
});

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('ImageStudioScreen', () => {
  it('lists only generated images for the business', async () => {
    const api = mockFetch([usage('ENTERPRISE'), list([generated('img_1'), generated('img_2')])]);
    renderWithSWR(<ImageStudioScreen />);
    const grid = await screen.findByRole('list', { name: 'Generated images' });
    expect(within(grid).getAllByRole('button')).toHaveLength(2);
    const call = api.find('GET', '/image-library')[0];
    expect(call?.query.get('source')).toBe('generated');
    expect(call?.query.get('businessId')).toBe('biz_1');
    expect(screen.getByRole('link', { name: 'Whole image library' })).toHaveAttribute(
      'href',
      '/business?tab=images',
    );
  });

  it('generates from the prompt, style and shape, and announces when it is ready', async () => {
    const api = mockFetch([
      usage('ENTERPRISE'),
      list([]),
      {
        method: 'POST',
        match: '/image-library/generate',
        status: 201,
        body: { ok: true, duplicate: false, image: generated('img_new') },
      },
    ]);
    renderWithSWR(<ImageStudioScreen />);
    expect(await screen.findByText('No generated images yet')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Generate image/ });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Describe the picture'), 'A loaf at dawn');
    await userEvent.type(screen.getByLabelText('Style (optional)'), 'film');
    await userEvent.click(screen.getByRole('radio', { name: '9:16' }));
    await userEvent.click(submit);
    await waitFor(() => expect(api.find('POST', '/image-library/generate')).toHaveLength(1));
    expect(api.find('POST', '/image-library/generate')[0]?.body).toEqual({
      businessId: 'biz_1',
      prompt: 'A loaf at dawn',
      style: 'film',
      aspectRatio: '9:16',
    });
    await waitFor(() =>
      expect(
        screen.getByText('Your image is ready — it’s in your library.', {
          selector: '[role=status]',
        }),
      ).toBeInTheDocument(),
    );
    // "Generate again" re-submits the same request.
    await userEvent.click(screen.getByRole('button', { name: 'Generate again' }));
    await waitFor(() => expect(api.find('POST', '/image-library/generate')).toHaveLength(2));
    expect(api.find('POST', '/image-library/generate')[1]?.body).toEqual(
      api.find('POST', '/image-library/generate')[0]?.body,
    );
  });

  it('previews an image with its prompt, a download link and Generate again', async () => {
    const api = mockFetch([
      usage('ENTERPRISE'),
      list([generated('img_1', { widthPx: 1792, heightPx: 1024 })]),
      {
        method: 'POST',
        match: '/image-library/generate',
        status: 201,
        body: { ok: true, duplicate: false, image: generated('img_2') },
      },
    ]);
    renderWithSWR(<ImageStudioScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open image: Prompt for img_1' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Generated image' });
    expect(within(dialog).getByText('warm film')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      'https://cdn.test/img_1.png',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate again' }));
    await waitFor(() => expect(api.find('POST', '/image-library/generate')).toHaveLength(1));
    expect(api.find('POST', '/image-library/generate')[0]?.body).toEqual({
      businessId: 'biz_1',
      prompt: 'Prompt for img_1',
      style: 'warm film',
      aspectRatio: '16:9',
    });
  });

  it('explains a plan without image generation and opens the upgrade dialog', async () => {
    const events: UpgradeEvent[] = [];
    const stop = subscribeUpgrade((e) => events.push(e));
    mockFetch([usage('BASIC'), list([generated('img_1')])]);
    renderWithSWR(<ImageStudioScreen />);
    expect(await screen.findByText('Image generation isn’t in your plan')).toBeInTheDocument();
    expect(screen.getByLabelText('Describe the picture')).toBeDisabled();
    // Earlier images stay visible.
    expect(
      await screen.findByRole('button', { name: 'Open image: Prompt for img_1' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'See what’s included' }));
    expect(events.map((e) => e.code)).toEqual(['plan_tier']);
    stop();
  });

  it('says when images are switched off for the organisation', async () => {
    mockFetch([
      usage('ENTERPRISE'),
      {
        match: '/image-library',
        status: 403,
        body: {
          ok: false,
          error: 'feature_disabled',
          message: 'The image-library feature is currently disabled',
        },
      },
    ]);
    renderWithSWR(<ImageStudioScreen />);
    expect(await screen.findByText('Images are switched off')).toBeInTheDocument();
    expect(screen.queryByLabelText('Describe the picture')).toBeNull();
  });

  it('shows a viewer the images without the form', async () => {
    mockFetch([
      usage('ENTERPRISE'),
      list([generated('img_1')]),
      {
        match: '/me',
        body: {
          ok: true,
          me: { capabilities: ['studio:project:read'], user: { platformRole: 'user' } },
        },
      },
    ]);
    renderWithSWR(<ImageStudioScreen />);
    expect(
      await screen.findByText(/Someone who can edit projects can make new ones/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Describe the picture')).toBeNull();
  });
});
