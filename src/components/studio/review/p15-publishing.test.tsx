// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DripQueuePanel } from '../calendar/drip-queue';
import { PublicationsList, viewsOf } from '../publications/publications-list';
import { bestTime, PublishPanel } from './publish-panel';
import { makeProject, makeRender, mockFetch, renderWithSWR } from './test-helpers';
import { VariantThumbnail } from './variant-thumbnail';
import type { Publication } from '@/lib/client/types';

// Phase 15 Track A screens: caption suggestions + best-time hint (A6/A7), variant thumbnail
// change (A3), views column + TikTok inbox note (A8/A2), drip queue panel (A5).

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const connections = {
  ok: true,
  data: [
    {
      id: 'c_tt',
      businessId: 'biz_1',
      platform: 'tiktok',
      platformAccountName: '@cafe',
      state: 'active',
    },
  ],
};

describe('PublishPanel (15.A6 / 15.A7)', () => {
  it('labels the best time', () => {
    expect(bestTime(undefined)).toBeNull();
    expect(
      bestTime({
        sufficientData: true,
        bestPerDay: [
          { weekday: 2, hour: 8, score: 1, basis: '4 videos' },
          { weekday: 4, hour: 18, score: 0.5, basis: '1 video' },
        ],
      }),
    ).toEqual({ weekday: 2, hour: 8, sufficientData: true });
    expect(
      bestTime({
        sufficientData: false,
        bestPerDay: [{ weekday: 0, hour: 9, score: 1, basis: 'style memory' }],
      }),
    ).toEqual({ weekday: 0, hour: 9, sufficientData: false });
  });

  it('fills captions from per-platform suggestions and shows the suggested time', async () => {
    const api = mockFetch([
      { match: '/platform-connections', body: connections },
      {
        match: '/analytics/best-times',
        body: {
          sufficientData: true,
          bestPerDay: [{ weekday: 2, hour: 8, score: 1, basis: '9 videos' }],
        },
      },
      {
        method: 'POST',
        match: /caption-suggestions/,
        body: {
          suggestions: {
            tiktok: {
              caption: 'Friday means sourdough',
              hashtags: ['AheadAI', 'leeds', 'bread', 'loaf', 'bakery'],
            },
          },
        },
      },
      { method: 'POST', match: '/publications', status: 202, body: { ok: true } },
    ]);
    const project = makeProject({ state: 'APPROVED', renders: [makeRender()] });
    renderWithSWR(<PublishPanel project={project} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    expect(await screen.findByText('Suggested: Tue 08:00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Suggest captions/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Caption')).toHaveValue('Friday means sourdough'),
    );
    expect(screen.getByText('#bakery')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Publish now \(1\)/ }));
    await waitFor(() => expect(api.find('POST', '/publications')).toHaveLength(1));
    expect(api.find('POST', '/publications')[0]?.body).toMatchObject({
      caption: 'Friday means sourdough',
      hashtags: ['AheadAI', 'leeds', 'bread', 'loaf', 'bakery'],
    });
  });
});

describe('VariantThumbnail (15.A3)', () => {
  it('shows the thumbnail and regenerates from a chosen frame', async () => {
    const api = mockFetch([
      {
        match: '/renders/ren_1',
        body: { render: { id: 'ren_1', thumbnailUrl: 'https://cdn.test/t.jpg' } },
      },
      {
        method: 'POST',
        match: '/renders/ren_1/thumbnail',
        body: { render: { id: 'ren_1', thumbnailUrl: 'https://cdn.test/t2.jpg' } },
      },
    ]);
    renderWithSWR(<VariantThumbnail render={{ id: 'ren_1', durationSec: 15 }} />);
    expect(await screen.findByAltText('Variant thumbnail')).toHaveAttribute(
      'src',
      'https://cdn.test/t.jpg',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.clear(screen.getByLabelText('Frame at (seconds)'));
    await userEvent.type(screen.getByLabelText('Frame at (seconds)'), '2.5');
    await userEvent.type(screen.getByLabelText('Overlay text (optional)'), '3 tips');
    await userEvent.click(screen.getByRole('button', { name: /Use this frame/ }));
    await waitFor(() => expect(api.find('POST', '/renders/ren_1/thumbnail')).toHaveLength(1));
    expect(api.find('POST', '/renders/ren_1/thumbnail')[0]?.body).toEqual({
      source: 'keyframe',
      atSec: 2.5,
      overlayText: '3 tips',
    });
  });

  it('shows a placeholder before a thumbnail exists', async () => {
    mockFetch([{ match: '/renders/ren_2', body: { render: { id: 'ren_2', thumbnailUrl: null } } }]);
    renderWithSWR(<VariantThumbnail render={{ id: 'ren_2', durationSec: 5 }} />);
    expect(await screen.findByLabelText('No thumbnail yet')).toBeInTheDocument();
  });
});

describe('Publications list (15.A8 / 15.A2)', () => {
  const base: Publication = {
    id: 'pub_1',
    projectId: 'prj_1',
    renderId: 'ren_1',
    platform: 'tiktok',
    platformAccountId: 'acc',
    state: 'PUBLISHED',
    scheduledFor: null,
    publishedAt: '2026-09-20T10:00:00.000Z',
    platformPostId: 'post',
    platformUrl: null,
    caption: null,
    hashtags: [],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: '2026-09-19T10:00:00.000Z',
    project: { id: 'prj_1', name: 'Autumn launch' },
  };

  it('formats live views', () => {
    expect(
      viewsOf({ ...base, latestMetrics: { views: 12345, likes: 1, comments: 0, at: 'x' } }),
    ).toBe('12,345');
    expect(viewsOf({ ...base, latestMetrics: null })).toBe('—');
  });

  it('shows the Views column and the TikTok inbox note', async () => {
    mockFetch([
      {
        match: '/publications',
        body: {
          data: [
            {
              ...base,
              latestMetrics: { views: 4200, likes: 3, comments: 1, at: '2026-09-21T00:00:00Z' },
            },
            {
              ...base,
              id: 'pub_2',
              metadata: { tiktokMode: 'inbox', note: 'Sent to your TikTok inbox.' },
              latestMetrics: null,
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    renderWithSWR(<PublicationsList />);
    expect(await screen.findByRole('columnheader', { name: 'Views' })).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
    expect(screen.getByText('Sent to your TikTok inbox.')).toBeInTheDocument();
  });
});

describe('DripQueuePanel (15.A5)', () => {
  it('shows the next slot and saves added slots', async () => {
    const api = mockFetch([
      {
        match: '/businesses/biz_1/drip-queue',
        body: {
          dripQueue: {
            slots: [{ weekday: 1, time: '08:30', timezone: 'Europe/London' }],
            platforms: [],
            enabled: true,
            staggerMinutes: 30,
            nextSlotAt: '2026-10-05T07:30:00.000Z',
            queued: 1,
            upcoming: [{ slotAt: '2026-09-28T07:30:00.000Z', projectId: 'prj_1' }],
          },
        },
      },
      { method: 'PUT', match: '/businesses/biz_1/drip-queue', body: { dripQueue: null } },
    ]);
    renderWithSWR(<DripQueuePanel />);
    expect(await screen.findByText(/1 queued/)).toBeInTheDocument();
    expect(screen.getByLabelText('Slot 1 day')).toHaveValue('1');
    await userEvent.click(screen.getByRole('button', { name: /Add slot/ }));
    await userEvent.click(screen.getByRole('button', { name: /Save schedule/ }));
    await waitFor(() => expect(api.find('PUT', '/businesses/biz_1/drip-queue')).toHaveLength(1));
    const body = api.find('PUT', '/businesses/biz_1/drip-queue')[0]?.body as { slots: unknown[] };
    expect(body.slots).toHaveLength(2);
  });
});
