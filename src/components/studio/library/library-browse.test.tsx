// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { BusinessProvider } from '../business-context';
import { LibraryBrowse } from './library-browse';
import { mockFetch, renderWithSWR, summary } from './test-helpers';

const categories = {
  ok: true,
  data: [
    {
      id: 'c1',
      slug: 'food',
      name: 'Food',
      parentId: null,
      depth: 0,
      children: [
        { id: 'c2', slug: 'food/cafes', name: 'Cafés', parentId: 'c1', depth: 1, children: [] },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('LibraryBrowse', () => {
  it('shows the grid of references with duration and licence modes', async () => {
    mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/videos',
        body: {
          ok: true,
          data: [summary(), summary({ id: 'lib_2', title: 'Gym hype', allowedModes: ['INSPIRE'] })],
          nextCursor: null,
        },
      },
    ]);
    renderWithSWR(<LibraryBrowse />);
    const coffee = await screen.findByRole('link', { name: /Morning coffee ritual/ });
    expect(coffee).toHaveAttribute('href', '/library/lib_1');
    expect(within(coffee).getByText('Template + Inspire')).toBeInTheDocument();
    expect(within(coffee).getByText('21s')).toBeInTheDocument();
    expect(screen.getByText('Inspire only')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    mockFetch([
      { match: '/library/categories', body: categories },
      { match: '/library/videos', body: { ok: true, data: [], nextCursor: null } },
    ]);
    renderWithSWR(<LibraryBrowse />);
    expect(await screen.findByText('No references match')).toBeInTheDocument();
  });

  it('shows an error state when the list fails', async () => {
    mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/videos',
        status: 500,
        body: { ok: false, error: 'internal', message: 'Database down' },
      },
    ]);
    renderWithSWR(<LibraryBrowse />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database down');
  });

  it('sends taxonomy filters to the list endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/library/categories', body: categories },
      { match: '/library/videos', body: { ok: true, data: [summary()], nextCursor: null } },
    ]);
    renderWithSWR(<LibraryBrowse />);
    await screen.findByRole('link', { name: /Morning coffee/ });

    await user.selectOptions(screen.getByLabelText('Category'), 'food/cafes');
    await user.selectOptions(screen.getByLabelText('Length'), 'medium');
    await user.type(screen.getByLabelText('Mood'), 'calm');
    await user.type(screen.getByLabelText('Tags'), 'Coffee, latte');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const last = calls.filter((c) => c.url.includes('/library/videos')).at(-1);
      const params = new URL(last?.url ?? '', 'http://x').searchParams;
      expect(params.get('category')).toBe('food/cafes');
      expect(params.get('durationMin')).toBe('15');
      expect(params.get('durationMax')).toBe('30');
      expect(params.get('mood')).toBe('calm');
      expect(params.get('tags')).toBe('coffee,latte');
    });
  });

  it('searches the whole library on the server (POST /library/search)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/videos',
        body: { ok: true, data: [summary()], nextCursor: null },
      },
      {
        match: '/library/search',
        method: 'POST',
        body: {
          ok: true,
          data: [summary({ id: 'lib_2', title: 'Gym hype', tags: ['fitness'], similarity: 0.83 })],
          nextCursor: null,
        },
      },
    ]);
    renderWithSWR(<LibraryBrowse />);
    await screen.findByRole('link', { name: /Morning coffee/ });
    await user.selectOptions(screen.getByLabelText('Category'), 'food');
    await user.type(screen.getByLabelText('Search the library'), 'moody gym');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('link', { name: /Gym hype/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Morning coffee/ })).not.toBeInTheDocument();
    expect(screen.getByText('83% match')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Results for “moody gym”');
    const post = calls.find((c) => c.url.includes('/library/search'));
    expect(post?.method).toBe('POST');
    expect(post?.body).toEqual({ q: 'moody gym', categorySlug: 'food', limit: 24, cursor: null });
  });

  it('says "No close matches" with categories to browse, not unrelated videos', async () => {
    const user = userEvent.setup();
    mockFetch([
      { match: '/library/categories', body: categories },
      { match: '/library/videos', body: { ok: true, data: [summary()], nextCursor: null } },
      { match: '/library/search', method: 'POST', body: { ok: true, data: [], nextCursor: null } },
    ]);
    renderWithSWR(<LibraryBrowse />);
    await screen.findByRole('link', { name: /Morning coffee/ });
    await user.type(screen.getByLabelText('Search the library'), 'luxury cars');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No close matches for “luxury cars”')).toBeInTheDocument();
    expect(screen.queryByText(/% match/)).not.toBeInTheDocument();
    // Suggestions: the top-level categories; one click leaves the search and browses it.
    await user.click(screen.getByRole('button', { name: 'Food' }));
    expect(await screen.findByRole('link', { name: /Morning coffee/ })).toBeInTheDocument();
    expect(screen.queryByText(/No close matches/)).not.toBeInTheDocument();
  });

  it('sends the length, mood and tag filters with a search and says they apply', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/library/categories', body: categories },
      { match: '/library/videos', body: { ok: true, data: [summary()], nextCursor: null } },
      { match: '/library/search', method: 'POST', body: { ok: true, data: [], nextCursor: null } },
    ]);
    renderWithSWR(<LibraryBrowse />);
    await screen.findByRole('link', { name: /Morning coffee/ });
    await user.selectOptions(screen.getByLabelText('Length'), 'medium');
    await user.type(screen.getByLabelText('Mood'), 'upbeat');
    await user.type(screen.getByLabelText('Tags'), 'Coffee, morning');
    await user.type(screen.getByLabelText('Search the library'), 'barista');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/library/search'))).toBe(true));
    const post = calls.find((c) => c.url.includes('/library/search'));
    expect(post?.body).toEqual({
      q: 'barista',
      durationMin: 15,
      durationMax: 30,
      mood: 'upbeat',
      tags: ['coffee', 'morning'],
      limit: 24,
      cursor: null,
    });
    expect(screen.getByRole('status')).not.toHaveTextContent(/don’t apply/);
  });

  it('pages with the cursor', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: 'cursor=lib_1',
        body: { ok: true, data: [summary({ id: 'lib_9', title: 'Page two' })], nextCursor: null },
      },
      { match: '/library/videos', body: { ok: true, data: [summary()], nextCursor: 'lib_1' } },
    ]);
    renderWithSWR(<LibraryBrowse />);
    await user.click(await screen.findByRole('button', { name: 'More references' }));
    expect(await screen.findByRole('link', { name: /Page two/ })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('cursor=lib_1'))).toBe(true);
  });

  it('asks for a business before recommending', async () => {
    mockFetch([
      { match: '/library/categories', body: categories },
      { match: '/library/videos', body: { ok: true, data: [], nextCursor: null } },
    ]);
    renderWithSWR(
      <BusinessProvider>
        <LibraryBrowse />
      </BusinessProvider>,
    );
    expect(await screen.findByText(/Pick a business in the top bar/)).toBeInTheDocument();
  });

  it('recommends references for the selected business', async () => {
    const { calls } = mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/recommended',
        body: {
          ok: true,
          data: [summary({ id: 'rec_1', title: 'Matched pick', similarity: 0.87 })],
        },
      },
      { match: '/library/videos', body: { ok: true, data: [], nextCursor: null } },
    ]);
    renderWithSWR(
      <BusinessProvider initial="biz_1">
        <LibraryBrowse />
      </BusinessProvider>,
    );
    const shelf = await screen.findByRole('list', { name: 'Recommended for your business' });
    expect(within(shelf).getByText('87% match')).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes('/library/recommended'))?.url).toContain(
      'businessId=biz_1',
    );
  });

  it('points to a website scan when the business has no profile', async () => {
    mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/recommended',
        status: 404,
        body: { ok: false, error: 'not_found', message: 'No business profile yet' },
      },
      { match: '/library/videos', body: { ok: true, data: [], nextCursor: null } },
    ]);
    renderWithSWR(
      <BusinessProvider initial="biz_1">
        <LibraryBrowse />
      </BusinessProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Scan your site' })).toHaveAttribute(
      'href',
      '/business',
    );
  });
});

describe('LibraryBrowse localisation', () => {
  function mockList() {
    mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/videos',
        body: {
          ok: true,
          data: [summary(), summary({ id: 'lib_2', title: 'Gym hype', allowedModes: ['INSPIRE'] })],
          nextCursor: null,
        },
      },
    ]);
  }

  it('renders in Arabic, right to left', async () => {
    mockList();
    renderWithSWR(withLocale('ar', <LibraryBrowse />));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'مكتبة المراجع' }),
    ).toBeInTheDocument();
    const coffee = await screen.findByRole('link', { name: /Morning coffee ritual/ });
    expect(within(coffee).getByText('قالب + إلهام')).toBeInTheDocument();
    expect(screen.getByText('إلهام فقط')).toBeInTheDocument();
    expect(screen.getByLabelText('الفئة')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('renders in Simplified Chinese', async () => {
    mockList();
    renderWithSWR(withLocale('zh-Hans', <LibraryBrowse />));
    expect(
      await screen.findByRole('heading', { level: 1, name: '参考视频库' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('仅限灵感')).toBeInTheDocument();
    expect(screen.getByLabelText('分类')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });
});
