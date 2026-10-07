// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/lib/client/types';
import { mockFetch, ok, renderScreen, type RecordedRequest } from '../publications/test-utils';
import { ProjectsList } from './projects-list';

// QA 3: search (debounced, kept in the URL), the Archived filter, and per-row duplicate / archive /
// unarchive / delete for roles that may write projects.

const nav = vi.hoisted(() => ({ params: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.params),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const project = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'prj_1',
    name: 'Sourdough launch',
    state: 'DRAFT',
    sourceType: 'BRIEF',
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
    costActualPence: 0,
    updatedAt: '2026-09-20T10:00:00.000Z',
    createdAt: '2026-09-19T10:00:00.000Z',
    ...overrides,
  }) as Project;

const WRITER = ['studio:project:read', 'studio:project:write'];
const READER = ['studio:project:read'];

function serve(rows: Project[], capabilities: string[] = WRITER, platformRole = 'user') {
  return mockFetch((req: RecordedRequest) => {
    if (req.url.pathname === '/api/studio/me')
      return ok({ me: { capabilities, user: { platformRole } } });
    if (req.method === 'GET' && req.url.pathname === '/api/studio/projects')
      return ok({ data: rows, nextCursor: null });
    return ok({ project: rows[0], archived: true });
  });
}

const listCalls = (api: ReturnType<typeof mockFetch>) => api.find('GET', '/projects');

beforeEach(() => {
  nav.params = '';
  nav.replace.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('ProjectsList search and filters', () => {
  it('searches after typing pauses, sends q, and writes it to the URL', async () => {
    const api = serve([project()]);
    const user = userEvent.setup();
    renderScreen(<ProjectsList />);
    await screen.findByText('Sourdough launch');

    await user.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'bread');
    // Not on every keystroke: one replace once typing stops.
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/projects?q=bread', { scroll: false }),
    );
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(listCalls(api).every((r) => r.url.searchParams.get('q') === null)).toBe(true);
  });

  it('reads ?q= and ?filter= from the URL, asks the API for them, and keeps them in the box', async () => {
    nav.params = 'q=bread&filter=archived';
    const api = serve([project({ state: 'ARCHIVED' })]);
    renderScreen(<ProjectsList />);
    await screen.findByText('Sourdough launch');
    const last = listCalls(api).at(-1)!;
    expect(last.url.searchParams.get('q')).toBe('bread');
    expect(last.url.searchParams.get('state')).toBe('ARCHIVED');
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('bread');
    expect(screen.getByRole('radio', { name: 'Archived' })).toHaveAttribute('aria-checked', 'true');
  });

  it('says nothing matched the search (not "no videos yet")', async () => {
    nav.params = 'q=zzz';
    serve([]);
    renderScreen(<ProjectsList />);
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.getByText('No project matches “zzz”.')).toBeInTheDocument();
    expect(screen.queryByText('No videos yet')).not.toBeInTheDocument();
  });

  it('the Archived filter goes into the URL', async () => {
    serve([project()]);
    const user = userEvent.setup();
    renderScreen(<ProjectsList />);
    await screen.findByText('Sourdough launch');
    await user.click(screen.getByRole('radio', { name: 'Archived' }));
    expect(nav.replace).toHaveBeenCalledWith('/projects?filter=archived', { scroll: false });
  });
});

describe('ProjectsList cost column (operator decision 2026-10-04)', () => {
  it('never shows customers what a video cost to make', async () => {
    const api = serve([project({ costActualPence: 1_234 })]);
    renderScreen(<ProjectsList />);
    await screen.findByText('Sourdough launch');
    await waitFor(() => expect(api.find('GET', '/me').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('project-row-cost')).not.toBeInTheDocument();
    expect(screen.queryByText('£12.34')).not.toBeInTheDocument();
  });

  it.each(['staff', 'superadmin'])('shows %s the cost of each video', async (role) => {
    serve([project({ costActualPence: 1_234 })], WRITER, role);
    renderScreen(<ProjectsList />);
    expect(await screen.findByTestId('project-row-cost')).toHaveTextContent('£12.34');
  });
});

describe('ProjectsList row actions', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Actions for Sourdough launch' }));
  }

  it('duplicates a project', async () => {
    const api = serve([project()]);
    const user = userEvent.setup();
    renderScreen(<ProjectsList />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(api.find('POST', '/projects/prj_1/duplicate')).toHaveLength(1));
  });

  it('archives, and an archived project offers Unarchive instead', async () => {
    const api = serve([project()]);
    const user = userEvent.setup();
    const first = renderScreen(<ProjectsList />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(api.find('POST', '/projects/prj_1/archive')).toHaveLength(1));
    first.unmount();

    const api2 = serve([project({ state: 'ARCHIVED' })]);
    renderScreen(<ProjectsList />);
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Unarchive' }));
    await waitFor(() => expect(api2.find('POST', '/projects/prj_1/unarchive')).toHaveLength(1));
  });

  it('deletes only after the confirm dialog', async () => {
    const api = serve([project()]);
    const user = userEvent.setup();
    renderScreen(<ProjectsList />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete this video?')).toBeInTheDocument();
    expect(api.find('DELETE', '/projects/prj_1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.find('DELETE', '/projects/prj_1')).toHaveLength(1));
  });

  it('cannot archive or delete a run in progress', async () => {
    serve([project({ state: 'RENDERING' })]);
    const user = userEvent.setup();
    renderScreen(<ProjectsList />);
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows no row actions to a role that may only read', async () => {
    serve([project()], READER);
    renderScreen(<ProjectsList />);
    await screen.findByText('Sourdough launch');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Actions for Sourdough launch' })).toBeNull(),
    );
  });
});
