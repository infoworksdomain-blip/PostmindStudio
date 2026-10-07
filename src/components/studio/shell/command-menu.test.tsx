// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { hasStudioPage } from '../../../../test/helpers/studio-pages';
import { BusinessProvider } from '../business-context';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { CommandMenu } from './command-menu';

// BACKLOG 25.4 — the command menu: keyboard (Ctrl/⌘K, arrows, Enter, Escape), filtering, project
// search through GET /projects?q=, and only real destinations and actions.

const push = vi.hoisted(() => vi.fn());
const setTheme = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const project = (id: string, name: string, state: string) => ({
  id,
  name,
  state,
  createdAt: '2026-10-01T10:00:00Z',
});

function api(projects: unknown[] = []) {
  return mockFetch([
    {
      match: '/businesses',
      body: {
        ok: true,
        local: true,
        data: [
          { id: 'biz_1', name: 'Crumb & Co' },
          { id: 'biz_2', name: 'Harbour Coffee' },
        ],
      },
    },
    { match: /\/projects\?/, body: { data: projects, nextCursor: null } },
  ]);
}

function menu() {
  return withLocale(
    'en-GB',
    <BusinessProvider initial="biz_1">
      <CommandMenu />
    </BusinessProvider>,
  );
}

async function openWithShortcut() {
  const user = userEvent.setup();
  renderWithSWR(menu());
  await user.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Search projects, pages and actions' });
  return { user, input };
}

describe('CommandMenu', () => {
  it('opens with Ctrl+K, lists the destinations and closes with Escape', async () => {
    api();
    const { user, input } = await openWithShortcut();
    expect(input).toHaveFocus();
    const list = screen.getByRole('listbox', { name: 'Results' });
    for (const name of ['Home', 'Calendar', 'Month plans', 'Analytics', 'Export data']) {
      expect(within(list).getByRole('option', { name })).toBeInTheDocument();
    }
    // The staff entry needs /me to say so (not mocked here).
    expect(within(list).queryByRole('option', { name: 'Admin' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens from the search button too, and Escape returns focus to it', async () => {
    api();
    const user = userEvent.setup();
    renderWithSWR(menu());
    const trigger = screen.getByRole('button', { name: 'Search or jump to…' });
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Command menu' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('filters as you type and moves the active option with the arrow keys; Enter navigates', async () => {
    api();
    const { user, input } = await openWithShortcut();
    await user.type(input, 'plan');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Calendar', 'Month plans', 'Plan a month']),
    );
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith(options.at(-1)!.getAttribute('data-href'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('searches projects through the projects list API (debounced) and opens one with Enter', async () => {
    const calls = api([
      project('prj_bread_1', 'Sourdough launch', 'READY_FOR_REVIEW'),
      project('prj_bread_2', 'Bread week', 'RENDERING'),
    ]);
    const { user, input } = await openWithShortcut();
    await user.type(input, 'bread');
    const first = await screen.findByRole('option', { name: /Sourdough launch/ });
    expect(within(first).getByText('Ready for review')).toBeInTheDocument();
    const searches = calls.calls.filter((c) => c.url.includes('/projects?'));
    // One request for the settled text, not one per keystroke.
    expect(searches).toHaveLength(1);
    expect(searches[0]!.url).toContain('q=bread');
    expect(searches[0]!.url).toContain('limit=8');
    expect(await screen.findByRole('status')).toHaveTextContent('2 results');
    await user.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith('/projects/prj_bread_1');
  });

  it('does not search projects for a single letter', async () => {
    const calls = api();
    const { user, input } = await openWithShortcut();
    await user.type(input, 'b');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.calls.some((c) => c.url.includes('/projects?'))).toBe(false);
  });

  it('switches business and appearance', async () => {
    api();
    const { user, input } = await openWithShortcut();
    await user.type(input, 'harbour');
    await user.click(await screen.findByRole('option', { name: 'Switch to Harbour Coffee' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'dark');
    await user.keyboard('{Enter}');
    expect(setTheme).toHaveBeenCalledWith('dark');
    // The current business is not offered as a switch.
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'switch');
    expect(screen.queryByRole('option', { name: 'Switch to Harbour Coffee' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Switch to Crumb & Co' })).toBeInTheDocument();
  });

  it('lists nothing fake: every destination is a real page', async () => {
    api();
    await openWithShortcut();
    const hrefs = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-href'))
      .filter((h): h is string => h !== null);
    expect(hrefs.length).toBeGreaterThan(15);
    for (const href of hrefs) expect(hasStudioPage(href), href).toBe(true);
  });

  it('says when nothing matches', async () => {
    api();
    const { user, input } = await openWithShortcut();
    await user.type(input, 'zz');
    expect(await screen.findByText('Nothing matches “zz”.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No results'));
  });
});
