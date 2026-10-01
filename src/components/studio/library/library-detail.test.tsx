// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { LibraryDetail } from './library-detail';
import { mockFetch, renderWithSWR, summary } from './test-helpers';
import type { BlueprintResponse, LibraryVideoDetail } from './types';

function detail(over: Partial<LibraryVideoDetail> = {}): LibraryVideoDetail {
  return {
    id: 'lib_1',
    title: 'Morning coffee ritual',
    description: 'A cosy café opening',
    tags: ['coffee'],
    durationSec: 21,
    aspectRatio: '9:16',
    sourcePlatform: 'tiktok',
    ingestedAt: '2026-09-01T00:00:00.000Z',
    category: { slug: 'food/cafes', name: 'Cafés' },
    analysis: {
      shotCount: 2,
      hookPattern: 'question',
      structurePattern: 'hook-demo-cta',
      ctaPattern: 'visit today',
      paceTag: 'fast-cut',
      moodTag: 'upbeat',
    },
    allowedModes: ['TEMPLATE', 'INSPIRE'],
    thumbnailUrl: 'https://cdn.test/thumb.jpg',
    previewUrl: 'https://cdn.test/preview.mp4',
    previewExpiresInSec: 600,
    ...over,
  };
}

const blueprint: BlueprintResponse = {
  ok: true,
  libraryVideoId: 'lib_1',
  allowedModes: ['TEMPLATE', 'INSPIRE'],
  blueprint: {
    shotCount: 2,
    totalDurationSec: 6,
    shots: [
      {
        durationSec: 1.5,
        type: 'HOOK_TEXT_ON_STILL',
        overlayStyle: 'bold-centre',
        voiceoverPresent: true,
        hasOnScreenText: true,
      },
      {
        durationSec: 4.5,
        type: 'CTA_CARD',
        overlayStyle: 'bold-bottom',
        voiceoverPresent: false,
        hasOnScreenText: false,
      },
    ],
    musicEnvelope: { bpm: 120, energy: 'high', moodTag: 'upbeat' },
    transitionSequence: ['cut', 'cut'],
    hookPattern: 'question',
    structurePattern: 'hook-demo-cta',
    ctaPattern: 'visit today',
    paceTag: 'fast-cut',
  },
  styleSignature: {
    paceTag: 'fast-cut',
    moodTag: 'upbeat',
    structurePattern: 'hook-demo-cta',
    musicGenreTag: 'lofi',
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('LibraryDetail', () => {
  it('shows the preview, facts and both reference modes', async () => {
    mockFetch([
      { match: '/library/videos/lib_1/similar', method: 'POST', body: { ok: true, data: [] } },
      { match: '/library/videos/lib_1', body: { ok: true, video: detail() } },
      { match: '/library/blueprint/lib_1', body: blueprint },
    ]);
    renderWithSWR(<LibraryDetail id="lib_1" />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Morning coffee ritual' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Muted preview of Morning coffee ritual')).toHaveAttribute(
      'src',
      'https://cdn.test/preview.mp4',
    );
    expect(screen.getByRole('link', { name: /Same video, my content/ })).toHaveAttribute(
      'href',
      '/new?reference=lib_1&mode=TEMPLATE',
    );
    expect(screen.getByRole('link', { name: /Make one like this/ })).toHaveAttribute(
      'href',
      '/new?reference=lib_1&mode=INSPIRE',
    );
  });

  it('draws the blueprint shot list and style signature', async () => {
    mockFetch([
      { match: '/library/videos/lib_1/similar', method: 'POST', body: { ok: true, data: [] } },
      { match: '/library/videos/lib_1', body: { ok: true, video: detail() } },
      { match: '/library/blueprint/lib_1', body: blueprint },
    ]);
    renderWithSWR(<LibraryDetail id="lib_1" />);
    const shots = await screen.findByRole('list', { name: 'Shot list' });
    const items = within(shots).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Hook text on still');
    expect(
      within(items[0] as HTMLElement).getByRole('img', { name: 'Voiceover' }),
    ).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('4.5s');
    expect(screen.getByText('120 bpm · high')).toBeInTheDocument();
    expect(screen.getByText('lofi')).toBeInTheDocument();
  });

  it('locks TEMPLATE for inspire-only references', async () => {
    mockFetch([
      { match: '/library/videos/lib_1/similar', method: 'POST', body: { ok: true, data: [] } },
      {
        match: '/library/videos/lib_1',
        body: { ok: true, video: detail({ allowedModes: ['INSPIRE'] }) },
      },
      {
        match: '/library/blueprint/lib_1',
        body: { ...blueprint, allowedModes: ['INSPIRE'], blueprint: null },
      },
    ]);
    renderWithSWR(<LibraryDetail id="lib_1" />);
    await screen.findByRole('link', { name: /Make one like this/ });
    expect(screen.queryByRole('link', { name: /Same video, my content/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Not available for this reference/)).toBeInTheDocument();
    expect(await screen.findByText(/Inspire-only reference/)).toBeInTheDocument();
  });

  it('asks for similar videos with a limit and shows them', async () => {
    const { calls } = mockFetch([
      {
        match: '/library/videos/lib_1/similar',
        method: 'POST',
        body: {
          ok: true,
          data: [summary({ id: 'lib_7', title: 'Cousin video', similarity: 0.91 })],
        },
      },
      { match: '/library/videos/lib_1', body: { ok: true, video: detail() } },
      { match: '/library/blueprint/lib_1', body: blueprint },
    ]);
    renderWithSWR(<LibraryDetail id="lib_1" />);
    const row = await screen.findByRole('list', { name: 'Similar references' });
    expect(within(row).getByRole('link', { name: /Cousin video/ })).toHaveAttribute(
      'href',
      '/library/lib_7',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ limit: 12 });
  });

  it('says so when the reference is gone', async () => {
    mockFetch([
      {
        match: '/library/videos/lib_x',
        status: 404,
        body: { ok: false, error: 'not_found', message: 'Library video not found' },
      },
    ]);
    renderWithSWR(<LibraryDetail id="lib_x" />);
    expect(await screen.findByText('Reference not found')).toBeInTheDocument();
  });

  it('explains when the video has not been analysed', async () => {
    mockFetch([
      { match: '/library/videos/lib_1/similar', method: 'POST', body: { ok: true, data: [] } },
      { match: '/library/videos/lib_1', body: { ok: true, video: detail({ analysis: null }) } },
      {
        match: '/library/blueprint/lib_1',
        status: 404,
        body: { ok: false, error: 'not_found', message: 'Library video not found' },
      },
    ]);
    renderWithSWR(<LibraryDetail id="lib_1" />);
    expect(await screen.findByText(/hasn’t been analysed yet/)).toBeInTheDocument();
  });
});

describe('LibraryDetail localisation', () => {
  function mockDetail() {
    mockFetch([
      { match: '/library/videos/lib_1/similar', method: 'POST', body: { ok: true, data: [] } },
      { match: '/library/videos/lib_1', body: { ok: true, video: detail() } },
      { match: '/library/blueprint/lib_1', body: blueprint },
    ]);
  }

  it('renders in Arabic, right to left', async () => {
    mockDetail();
    renderWithSWR(withLocale('ar', <LibraryDetail id="lib_1" />));
    // The title is user content: never translated.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Morning coffee ritual' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /الفيديو نفسه بمحتواي/ })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'قائمة اللقطات' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'كيف بُني' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('renders in Simplified Chinese', async () => {
    mockDetail();
    renderWithSWR(withLocale('zh-Hans', <LibraryDetail id="lib_1" />));
    expect(await screen.findByRole('link', { name: /做一个类似的/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '用作参考' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: '镜头列表' })).toBeInTheDocument();
  });
});
