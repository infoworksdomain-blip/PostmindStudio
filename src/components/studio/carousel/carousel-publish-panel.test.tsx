// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { mockFetch, renderWithSWR } from '../review/test-helpers';
import { CarouselPublishPanel } from './carousel-publish-panel';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
afterEach(() => vi.unstubAllGlobals());

const slides = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    index,
    pngKey: `${index}.png`,
    jpegKey: `${index}.jpg`,
    width: 1080,
    height: 1350,
    altText: '',
    postIds: [],
  }));

const project = (count: number) =>
  ({
    id: 'p1',
    renders: [
      {
        id: 'r1',
        targetPlatform: 'carousel',
        qualityCheckState: 'PASSED',
        composition: {
          kind: 'carousel',
          version: 1,
          bucket: 'b',
          theme: 'light',
          language: 'en-GB',
          aiGenerated: true,
          slides: slides(count),
          issues: [],
        },
      },
    ],
  }) as unknown as ProjectDetail;

const connections = {
  ok: true,
  data: [
    {
      id: 'ig',
      businessId: 'biz_1',
      platform: 'instagram',
      platformAccountName: '@acme',
      state: 'active',
    },
    {
      id: 'yt',
      businessId: 'biz_1',
      platform: 'youtube',
      platformAccountName: 'Acme TV',
      state: 'active',
    },
  ],
};
const postCopy = {
  ok: true,
  platforms: { instagram_feed: { caption: 'Bread tips', hashtags: ['a', 'b', 'c', 'd', 'e'] } },
};

function routes() {
  return [
    { match: '/platform-connections', body: connections },
    { match: '/projects/p1/post-copy', body: postCopy },
    {
      method: 'POST',
      match: '/publications',
      status: 201,
      body: { ok: true, publication: { id: 'pub' } },
    },
  ];
}

describe('CarouselPublishPanel', () => {
  it('publishes to the connected Instagram account with its caption and hashtags', async () => {
    const api = mockFetch(routes());
    const onChanged = vi.fn();
    renderWithSWR(
      <CarouselPublishPanel project={project(4)} businessId="biz_1" onChanged={onChanged} />,
    );
    expect(await screen.findByLabelText('@acme')).toBeChecked();
    expect(
      screen.getByText('YouTube posts videos only. Download the slides instead.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/labelled as AI-generated/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Caption')).toHaveValue('Bread tips'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish 1 post' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/publications')[0]?.body).toEqual({
      renderId: 'r1',
      platform: 'instagram_feed',
      connectionId: 'ig',
      caption: 'Bread tips',
      hashtags: ['a', 'b', 'c', 'd', 'e'],
    });
  });

  it('explains when Instagram cannot take that many slides', async () => {
    mockFetch(routes());
    renderWithSWR(
      <CarouselPublishPanel project={project(12)} businessId="biz_1" onChanged={vi.fn()} />,
    );
    expect(
      await screen.findByText('Takes at most 10 slides. Remove posts to publish here.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish 0 posts' })).toBeDisabled();
  });
});
