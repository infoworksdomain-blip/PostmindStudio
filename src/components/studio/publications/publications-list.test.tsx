// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Publication } from '@/lib/client/types';
import { PUBLICATIONS_POLL_MS, PublicationsList, publicationsRefreshMs } from './publications-list';
import { fail, mockFetch, ok, renderScreen } from './test-utils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function pub(overrides: Partial<Publication>): Publication {
  return {
    id: 'pub_1',
    projectId: 'prj_1',
    renderId: 'ren_1',
    platform: 'tiktok',
    platformAccountId: 'acc',
    state: 'PUBLISHED',
    scheduledFor: null,
    publishedAt: '2026-09-20T10:00:00.000Z',
    platformPostId: 'post',
    platformUrl: 'https://tiktok.example/post',
    caption: null,
    hashtags: [],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: '2026-09-19T10:00:00.000Z',
    project: { id: 'prj_1', name: 'Autumn launch' },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('PublicationsList', () => {
  it('shows a loading state, then rows with state badges and platform links', async () => {
    mockFetch(() => ok({ data: [pub({})], nextCursor: null }));
    renderScreen(<PublicationsList />);
    expect(screen.getByLabelText('Loading publications')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Autumn launch' })).toHaveAttribute(
      'href',
      '/projects/prj_1',
    );
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open Autumn launch on TikTok' })).toHaveAttribute(
      'href',
      'https://tiktok.example/post',
    );
  });

  it('shows the empty state', async () => {
    mockFetch(() => ok({ data: [], nextCursor: null }));
    renderScreen(<PublicationsList />);
    expect(await screen.findByText('Nothing published yet')).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    mockFetch(() => fail(500, 'Database unavailable'));
    renderScreen(<PublicationsList />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
  });

  it('sends state and platform filters and paginates with the cursor', async () => {
    const api = mockFetch(() => ok({ data: [pub({})], nextCursor: 'pub_1' }));
    const user = userEvent.setup();
    renderScreen(<PublicationsList />);
    await screen.findByRole('link', { name: 'Autumn launch' });

    await user.click(screen.getByRole('radio', { name: 'Failed' }));
    await user.selectOptions(screen.getByLabelText('Platform'), 'youtube');
    await waitFor(() => {
      const last = api.requests.at(-1)!;
      expect(last.url.searchParams.get('state')).toBe('FAILED');
      expect(last.url.searchParams.get('platform')).toBe('youtube');
    });
    await screen.findByRole('link', { name: 'Autumn launch' });
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(api.requests.at(-1)!.url.searchParams.get('cursor')).toBe('pub_1'));
  });

  it('retries a failed publication with an idempotency key', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ publication: pub({ state: 'PUBLISHING' }) })
        : ok({
            data: [
              pub({
                state: 'FAILED',
                errorReason: 'tiktok/needs_reconnect: Token expired',
                platformUrl: null,
              }),
            ],
            nextCursor: null,
          }),
    );
    const user = userEvent.setup();
    renderScreen(<PublicationsList />);
    // The sentence for the class; the platform's own text ("Token expired") is staff-only.
    expect(await screen.findByText(/the account needs to be reconnected/)).toBeInTheDocument();
    expect(screen.queryByText(/Token expired/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.find('POST', '/publications/pub_1/retry')).toHaveLength(1));
    expect(
      api.find('POST', '/publications/pub_1/retry')[0]!.headers['idempotency-key'],
    ).toBeTruthy();
  });

  it('asks before taking a post down and only then calls takedown', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ publication: pub({ state: 'TAKEN_DOWN' }) })
        : ok({ data: [pub({})], nextCursor: null }),
    );
    const user = userEvent.setup();
    renderScreen(<PublicationsList />);
    await user.click(await screen.findByRole('button', { name: 'Take down' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Take this post down from TikTok?');
    expect(api.find('POST', '/publications/pub_1/takedown')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.find('POST', '/publications/pub_1/takedown')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Take down' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Take down' }),
    );
    await waitFor(() => expect(api.find('POST', '/publications/pub_1/takedown')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('cancels a scheduled publication after confirmation', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ publication: pub({ state: 'CANCELLED' }) })
        : ok({
            data: [
              pub({
                state: 'SCHEDULED',
                publishedAt: null,
                platformUrl: null,
                scheduledFor: '2026-10-01T09:00:00.000Z',
              }),
            ],
            nextCursor: null,
          }),
    );
    const user = userEvent.setup();
    renderScreen(<PublicationsList />);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel post' }),
    );
    await waitFor(() => expect(api.find('POST', '/publications/pub_1/cancel')).toHaveLength(1));
  });

  it('keeps the dialog open when the action fails', async () => {
    const { toast } = await import('sonner');
    mockFetch((req) =>
      req.method === 'POST'
        ? fail(409, 'Only published posts can be taken down')
        : ok({ data: [pub({})], nextCursor: null }),
    );
    const user = userEvent.setup();
    renderScreen(<PublicationsList />);
    await user.click(await screen.findByRole('button', { name: 'Take down' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Take down' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Only published posts can be taken down'),
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('publicationsRefreshMs (QA 3: a post in flight must not stay "Publishing" until a reload)', () => {
  it('polls while a post is publishing or queued to go out now', () => {
    expect(publicationsRefreshMs({ data: [pub({ state: 'PUBLISHING' })] })).toBe(
      PUBLICATIONS_POLL_MS,
    );
    expect(publicationsRefreshMs({ data: [pub({ state: 'SCHEDULED', scheduledFor: null })] })).toBe(
      PUBLICATIONS_POLL_MS,
    );
  });

  it('does not poll for settled, failed or future-scheduled posts, or before data arrives', () => {
    expect(publicationsRefreshMs(undefined)).toBe(0);
    expect(publicationsRefreshMs({ data: [] })).toBe(0);
    expect(
      publicationsRefreshMs({
        data: [
          pub({ state: 'PUBLISHED' }),
          pub({ state: 'FAILED' }),
          pub({ state: 'SCHEDULED', scheduledFor: '2099-01-01T00:00:00.000Z' }),
        ],
      }),
    ).toBe(0);
  });
});
