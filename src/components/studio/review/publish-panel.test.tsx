// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationsList } from './publications-list';
import { parseHashtags, PublishPanel } from './publish-panel';
import { makeProject, makeRender, mockFetch, renderWithSWR } from './test-helpers';
import type { Publication } from '@/lib/client/types';

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
    {
      id: 'c_other',
      businessId: 'biz_2',
      platform: 'tiktok',
      platformAccountName: '@other',
      state: 'active',
    },
    {
      id: 'c_yt',
      businessId: 'biz_1',
      platform: 'youtube',
      platformAccountName: 'Cafe TV',
      state: 'needs_reconnect',
    },
  ],
};

const approved = makeProject({
  state: 'APPROVED',
  renders: [
    makeRender(),
    makeRender({ id: 'ren_2', targetPlatform: 'youtube_short' }),
    makeRender({ id: 'ren_3', targetPlatform: 'instagram_reel' }),
    makeRender({ id: 'ren_4', targetPlatform: 'x', qualityCheckState: 'FAILED' }),
  ],
});

describe('PublishPanel', () => {
  it('parses hashtags', () => {
    expect(parseHashtags('#spring, menu  #spring ##new')).toEqual(['spring', 'menu', 'new']);
  });

  it('offers only active connections for this business and publishes now', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      { match: '/platform-connections', body: connections },
      { method: 'POST', match: '/publications', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={onChanged} />);
    const account = await screen.findByLabelText('Account');
    expect(account).toHaveDisplayValue('@cafe');
    expect(screen.queryByText('@other')).not.toBeInTheDocument();
    expect(screen.getByText(/Connect YouTube Shorts/)).toBeInTheDocument();
    expect(screen.getByText(/PostMind Engagement’s Meta account/)).toBeInTheDocument();
    expect(screen.queryByText('X')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Caption'));
    await userEvent.type(screen.getByLabelText('Caption'), 'New plates');
    await userEvent.type(screen.getByLabelText('Hashtags'), '#spring food');
    await userEvent.click(screen.getByRole('button', { name: /Publish now \(1\)/ }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [call] = api.find('POST', '/publications');
    expect(call?.body).toEqual({
      renderId: 'ren_1',
      platform: 'tiktok',
      connectionId: 'c_tt',
      caption: 'New plates',
      hashtags: ['spring', 'food'],
    });
    expect(call?.headers['idempotency-key']).toBeTruthy();
  });

  it('schedules when a time is set', async () => {
    const api = mockFetch([
      { match: '/platform-connections', body: connections },
      { method: 'POST', match: '/publications', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    await userEvent.type(screen.getByLabelText('Schedule (optional)'), '2026-10-01T09:30');
    await userEvent.click(screen.getByRole('button', { name: /Schedule \(1\)/ }));
    await waitFor(() => expect(api.find('POST', '/publications')).toHaveLength(1));
    const body = api.find('POST', '/publications')[0]?.body as { scheduledFor: string };
    expect(body.scheduledFor).toBe(new Date('2026-10-01T09:30').toISOString());
  });

  it('lets a variant be skipped', async () => {
    mockFetch([{ match: '/platform-connections', body: connections }]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    await userEvent.click(screen.getByRole('checkbox', { name: 'TikTok' }));
    expect(screen.getByRole('button', { name: /Publish now \(0\)/ })).toBeDisabled();
  });

  it('says when nothing passed quality', () => {
    mockFetch([{ match: '/platform-connections', body: connections }]);
    renderWithSWR(
      <PublishPanel
        project={makeProject({
          state: 'APPROVED',
          renders: [makeRender({ qualityCheckState: 'FAILED' })],
        })}
        businessId="biz_1"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('No variant has passed its quality check.')).toBeInTheDocument();
  });
});

const publication = (over: Partial<Publication>): Publication => ({
  id: 'pub_1',
  projectId: 'proj_1',
  renderId: 'ren_1',
  platform: 'tiktok',
  platformAccountId: 'acc',
  state: 'SCHEDULED',
  scheduledFor: '2026-10-01T09:30:00.000Z',
  publishedAt: null,
  platformPostId: null,
  platformUrl: null,
  caption: null,
  hashtags: [],
  errorReason: null,
  errorCode: null,
  retryCount: 0,
  createdAt: '2026-09-26T10:00:00.000Z',
  ...over,
});

describe('PublicationsList', () => {
  it('cancels a scheduled post and retries a failed one', async () => {
    const onChanged = vi.fn();
    const api = mockFetch([
      { method: 'POST', match: '/publications/pub_1/cancel', body: { ok: true } },
      { method: 'POST', match: '/publications/pub_2/retry', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(
      <PublicationsList
        onChanged={onChanged}
        publications={[
          publication({}),
          publication({ id: 'pub_2', state: 'FAILED', errorReason: 'token expired' }),
          publication({ id: 'pub_3', state: 'PUBLISHED', platformUrl: 'https://tiktok.test/1' }),
        ]}
      />,
    );
    expect(screen.getByText(/token expired/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View/ })).toHaveAttribute(
      'href',
      'https://tiktok.test/1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel TikTok post' }));
    await waitFor(() => expect(api.find('POST', '/publications/pub_1/cancel')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Retry TikTok post' }));
    await waitFor(() => expect(api.find('POST', '/publications/pub_2/retry')).toHaveLength(1));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('has an empty state', () => {
    mockFetch([]);
    renderWithSWR(<PublicationsList onChanged={vi.fn()} publications={[]} />);
    expect(screen.getByText('Nothing published or scheduled yet.')).toBeInTheDocument();
  });
});
