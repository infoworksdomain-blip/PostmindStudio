// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationsList } from './publications-list';
import { parseHashtags, PublishPanel } from './publish-panel';
import { makeProject, makeRender, mockFetch, renderWithSWR } from './test-helpers';
import type { Publication } from '@/lib/client/types';
import { toLocalInput } from '../calendar/month';

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
  // Core mode: PostMind Core runs the Meta login (standalone: see the test below).
  meta: { connect: 'core', configured: true },
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

  it('20.12: with no connected account it says so once and links to Connections', async () => {
    mockFetch([
      {
        match: '/platform-connections',
        body: { ok: true, data: [], meta: { connect: 'studio', configured: true } },
      },
    ]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    expect(
      await screen.findByText(/No connected accounts yet, so there is nowhere to publish/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/connections',
    );
    expect(screen.getByRole('button', { name: 'Publish now (0)' })).toBeDisabled();
  });

  it('20.12: no notice while some variant has an account', async () => {
    mockFetch([{ match: '/platform-connections', body: connections }]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    expect(screen.queryByText(/nowhere to publish/)).not.toBeInTheDocument();
  });

  it('standalone: a missing Instagram account links to Connections, not PostMind settings', async () => {
    mockFetch([
      {
        match: '/platform-connections',
        body: { ...connections, meta: { connect: 'studio', configured: true } },
      },
    ]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    expect(screen.queryByText(/PostMind settings/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect Instagram/ })).toHaveAttribute(
      'href',
      '/connections',
    );
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
    // No Instagram account registered: guidance points to PostMind settings, not an OAuth link.
    expect(
      screen.getByText(/Connect Instagram and Facebook in PostMind settings/),
    ).toBeInTheDocument();
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

  it('offers an organisation-wide Instagram account registered by PostMind', async () => {
    const api = mockFetch([
      {
        match: '/platform-connections',
        body: {
          ok: true,
          data: [
            {
              id: 'c_ig',
              businessId: null,
              platform: 'instagram',
              platformAccountId: '17841400000000001',
              platformAccountName: '@cafe.ig',
              state: 'active',
            },
          ],
        },
      },
      { method: 'POST', match: '/publications', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    expect(await screen.findByLabelText('Account')).toHaveDisplayValue('@cafe.ig');
    await userEvent.click(screen.getByRole('button', { name: /Publish now \(1\)/ }));
    await waitFor(() => expect(api.find('POST', '/publications')).toHaveLength(1));
    expect(api.find('POST', '/publications')[0]?.body).toMatchObject({
      renderId: 'ren_3',
      platform: 'instagram_reel',
      connectionId: 'c_ig',
    });
  });

  it('schedules when a time is set', async () => {
    const api = mockFetch([
      { match: '/platform-connections', body: connections },
      { method: 'POST', match: '/publications', status: 202, body: { ok: true } },
    ]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    // 20.3: the client refuses past and too-far times, so the time is relative to now.
    const when = toLocalInput(new Date(Date.now() + 2 * 86_400_000).toISOString());
    await userEvent.type(screen.getByLabelText('Schedule (optional)'), when);
    await userEvent.click(screen.getByRole('button', { name: /Schedule \(1\)/ }));
    await waitFor(() => expect(api.find('POST', '/publications')).toHaveLength(1));
    const body = api.find('POST', '/publications')[0]?.body as { scheduledFor: string };
    expect(body.scheduledFor).toBe(new Date(when).toISOString());
  });

  it('20.3: bounds the schedule to 180 days and says so before calling the API', async () => {
    const api = mockFetch([{ match: '/platform-connections', body: connections }]);
    renderWithSWR(<PublishPanel project={approved} businessId="biz_1" onChanged={vi.fn()} />);
    await screen.findByLabelText('Account');
    const input = screen.getByLabelText('Schedule (optional)');
    const max = Date.parse(input.getAttribute('max') ?? '');
    expect(Math.round((max - Date.now()) / 86_400_000)).toBe(180);
    expect(input.getAttribute('min')).toBeTruthy();
    await userEvent.type(
      input,
      toLocalInput(new Date(Date.now() + 181 * 86_400_000).toISOString()),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a time no more than 180 days ahead.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /Schedule \(1\)/ })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, toLocalInput(new Date(Date.now() - 86_400_000).toISOString()));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a time at least a minute from now.');
    expect(api.find('POST', '/publications')).toHaveLength(0);
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
    // QA 3: a reason with no known code is raw text from outside Studio: customers get the
    // generic sentence (staff read the stored text).
    expect(screen.getByText(/This step failed/)).toBeInTheDocument();
    expect(screen.queryByText(/token expired/)).toBeNull();
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
