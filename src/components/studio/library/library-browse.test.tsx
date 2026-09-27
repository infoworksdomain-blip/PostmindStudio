// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('narrows the loaded page with the search box', async () => {
    const user = userEvent.setup();
    mockFetch([
      { match: '/library/categories', body: categories },
      {
        match: '/library/videos',
        body: {
          ok: true,
          data: [summary(), summary({ id: 'lib_2', title: 'Gym hype', tags: ['fitness'] })],
          nextCursor: null,
        },
      },
    ]);
    renderWithSWR(<LibraryBrowse />);
    await screen.findByRole('link', { name: /Gym hype/ });
    await user.type(screen.getByLabelText('Search this page'), 'fitness');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /Morning coffee/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /Gym hype/ })).toBeInTheDocument();
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
