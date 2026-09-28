// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, summary, type MockRoute } from '../library/test-helpers';
import { parseUrls } from './ingest-form';
import { buildPatch } from './library-edit-dialog';
import { LibraryAdminPanel } from './library-admin-panel';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { withLocale } from '../../../../test/i18n-wrapper';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const categories = {
  ok: true,
  data: [
    { id: 'c1', slug: 'food', name: 'Food', parentId: null, depth: 0, children: [] },
    { id: 'c2', slug: 'fitness', name: 'Fitness', parentId: null, depth: 0, children: [] },
  ],
};

const ingestStatus = {
  ok: true,
  windowHours: 24,
  since: '2026-09-26T12:00:00.000Z',
  counts: { QUEUED: 40, RUNNING: 2, SUCCEEDED: 55, DUPLICATE: 1, FAILED: 2 },
  total: 100,
  completedPerHour: 2.3,
  backlog: { queued: 40, running: 2 },
  liveLibraryItems: 56,
  recentFailures: [
    {
      runId: 'r1',
      sourceUrl: 'https://a.test/broken.mp4',
      sourceRef: 'ext-9',
      errorReason: 'Source returned HTTP 404',
      attempts: 1,
      finishedAt: '2026-09-27T11:00:00.000Z',
    },
  ],
};

// 15.D7: the corpus list is the staff endpoint (every row with its licence status) and the panel
// shows the licence audit.
const adminRow = {
  ...summary(),
  ingestedAt: '2026-09-20T10:00:00.000Z',
  retiredAt: null,
  reanalysedAt: null,
  categoryReview: null,
  categoryReviewedAt: null,
  licence: { status: 'ok', scenario: 'OWNED', licenseExpires: null, licenseSource: null },
};

const licenceAudit = {
  ok: true,
  generatedAt: '2026-09-27T12:00:00.000Z',
  expiringWithinDays: 30,
  live: 56,
  retired: 0,
  byScenario: { LICENSED: 20, OWNED: 36, SCRAPED: 0, NOT_REQUIRED: 0 },
  missing: 0,
  expired: 0,
  expiringSoon: 0,
  problems: [],
  problemsTruncated: false,
};

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/library/categories', body: categories },
    { match: '/admin/library/licence-audit', body: licenceAudit },
    { match: '/admin/library/videos', body: { ok: true, data: [adminRow], nextCursor: null } },
    { match: '/library/videos', body: { ok: true, data: [summary()], nextCursor: null } },
    { match: '/admin/library/ingest/status', body: ingestStatus },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('LibraryAdminPanel', () => {
  it('queues a batch of URLs with the shared licence, category and tags', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes([
        {
          match: '/admin/library/ingest',
          method: 'POST',
          body: {
            ok: true,
            queued: [
              { sourceUrl: 'https://a.test/1.mp4', jobId: 'ingest-aaa' },
              { sourceUrl: 'https://a.test/2.mp4', jobId: 'ingest-bbb' },
            ],
          },
        },
      ]),
    );
    renderWithSWR(<LibraryAdminPanel />);
    await screen.findAllByRole('option', { name: 'Fitness' });
    await user.type(
      screen.getByLabelText('Source URLs'),
      'https://a.test/1.mp4{Enter}https://a.test/2.mp4',
    );
    await user.selectOptions(screen.getByLabelText('Licence'), 'SCRAPED');
    await user.selectOptions(
      screen.getByLabelText('Category', { selector: '#ingest-category' }),
      'fitness',
    );
    await user.type(screen.getByLabelText('Tags'), 'Gym, hype');
    await user.click(screen.getByRole('button', { name: /Queue 2 for ingestion/ }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      items: [
        {
          sourceUrl: 'https://a.test/1.mp4',
          licenseScenario: 'SCRAPED',
          tags: ['gym', 'hype'],
          category: 'fitness',
        },
        {
          sourceUrl: 'https://a.test/2.mp4',
          licenseScenario: 'SCRAPED',
          tags: ['gym', 'hype'],
          category: 'fitness',
        },
      ],
    });
    expect(post?.headers['idempotency-key']).toBeTruthy();
    const queued = await screen.findByRole('list', { name: 'Queued ingest jobs' });
    expect(within(queued).getAllByRole('listitem')).toHaveLength(2);
  });

  it('blocks invalid URLs', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderWithSWR(<LibraryAdminPanel />);
    await user.type(screen.getByLabelText('Source URLs'), 'not a url');
    expect(screen.getByText(/Not a valid http\(s\) URL: not a url/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /for ingestion/ })).toBeDisabled();
  });

  it('retires an item after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes([
        {
          match: '/admin/library/videos/lib_1/retire',
          method: 'POST',
          body: { ok: true, retired: true },
        },
      ]),
    );
    renderWithSWR(<LibraryAdminPanel />);
    await user.click(await screen.findByRole('button', { name: 'Retire Morning coffee ritual' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Retire' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/lib_1/retire'))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('patches only the fields that changed', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes([
        { match: '/admin/library/videos/lib_1', method: 'PATCH', body: { ok: true, video: {} } },
      ]),
    );
    renderWithSWR(<LibraryAdminPanel />);
    await screen.findAllByRole('option', { name: 'Fitness' });
    await user.click(await screen.findByRole('button', { name: 'Edit Morning coffee ritual' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Coffee ritual');
    await user.selectOptions(within(dialog).getByLabelText('Licence'), 'OWNED');
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        title: 'Coffee ritual',
        licenseScenario: 'OWNED',
      }),
    );
  });

  it('shows an error when the corpus list fails', async () => {
    mockFetch([
      { match: '/library/categories', body: categories },
      { match: '/admin/library/licence-audit', body: licenceAudit },
      {
        match: '/admin/library/videos',
        status: 500,
        body: { ok: false, error: 'internal', message: 'Search index offline' },
      },
      { match: '/admin/library/ingest/status', body: ingestStatus },
    ]);
    renderWithSWR(<LibraryAdminPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Search index offline');
  });
});

describe('admin library helpers', () => {
  it('splits, de-duplicates and validates URLs', () => {
    expect(parseUrls('https://a.test/x\n\nhttps://a.test/x\nftp://b.test\nnope')).toEqual({
      urls: ['https://a.test/x'],
      invalid: ['ftp://b.test', 'nope'],
    });
  });

  it('builds an empty patch when nothing changed', () => {
    const video = summary();
    expect(
      buildPatch(video, {
        title: video.title,
        description: video.description ?? '',
        category: video.category.slug,
        tags: video.tags.join(', '),
        scenario: '',
        licenseSource: '',
      }),
    ).toEqual({});
  });

  it('clears a description to null and normalises tags', () => {
    const video = summary();
    expect(
      buildPatch(video, {
        title: video.title,
        description: '  ',
        category: 'fitness',
        tags: 'Coffee, New',
        scenario: '',
        licenseSource: 'Deal #4',
      }),
    ).toEqual({
      description: null,
      category: 'fitness',
      tags: ['coffee', 'new'],
      licenseSource: 'Deal #4',
    });
  });
});

describe('LibraryAdminPanel corpus ingestion', () => {
  it('shows corpus ingestion status with counts, backlog and recent failures', async () => {
    const { calls } = mockFetch(routes());
    renderWithSWR(<LibraryAdminPanel />);
    const counts = await screen.findByRole('group', { name: 'Ingestion counts' });
    expect(within(counts).getByText('55')).toBeInTheDocument();
    expect(within(counts).getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/40 queued · 2 running · 2.3 completed per hour/)).toBeInTheDocument();
    const failures = screen.getByRole('list', { name: 'Recent ingestion failures' });
    expect(within(failures).getByText(/Source returned HTTP 404/)).toBeInTheDocument();
    expect(within(failures).getByText(/ext-9/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Window'), '1');
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/admin/library/ingest/status?windowHours=1'))).toBe(
        true,
      ),
    );
  });

  it('offers the operator-owned NOT_REQUIRED licence for ingestion', async () => {
    mockFetch(routes());
    renderWithSWR(<LibraryAdminPanel />);
    expect(
      await screen.findByRole('option', { name: /Not required — operator-owned/ }),
    ).toBeInTheDocument();
  });
});

describe('LibraryAdminPanel localisation', () => {
  it('renders Arabic right-to-left', async () => {
    mockFetch(routes());
    renderWithSWR(withLocale('ar', <LibraryAdminPanel />));
    const ar = ALL_MESSAGES.ar.admin.library;
    expect(await screen.findByText(ar.panel.corpusTitle)).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: ar.status.countsAria })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: ar.row.editAria.replace('{title}', 'Morning coffee ritual'),
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
  });

  it('renders Simplified Chinese', async () => {
    mockFetch(routes());
    renderWithSWR(withLocale('zh-Hans', <LibraryAdminPanel />));
    expect(await screen.findByText('语料库')).toBeInTheDocument();
    expect(await screen.findByText('许可审计')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '添加到语料库' })).toBeInTheDocument();
  });
});
