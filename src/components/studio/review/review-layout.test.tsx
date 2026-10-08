// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { ReviewScreen } from './review-screen';
import { makeProject, makeRender, mockFetch, renderWithSWR, type MockRoute } from './test-helpers';
import { resolveTab, withTab } from './use-tab-param';

// BACKLOG 25.8 — the player-first review layout: what each project state shows, the one
// "Needs your attention" list, the secondary actions menu and the tab kept in the URL.

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/projects/proj_1',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function routes(project: ProjectDetail, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: `/projects/${project.id}`, body: { ok: true, project } },
    {
      match: /\/renders\/[^/]+\/preview$/,
      body: { ok: true, url: 'https://cdn.test/render.mp4', expiresInSec: 3600 },
    },
    {
      match: /\/renders\/[^/]+$/,
      body: { ok: true, render: { thumbnailUrl: 'https://cdn.test/poster.jpg' } },
    },
    { match: '/platform-connections', body: { ok: true, data: [] } },
  ];
}

beforeEach(() => {
  nav.search = '';
  nav.replace.mockReset();
  nav.push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

async function open(project: ProjectDetail, extra: MockRoute[] = []) {
  const api = mockFetch(routes(project, extra));
  renderWithSWR(<ReviewScreen projectId={project.id} />);
  await screen.findByRole('heading', { name: 'Spring menu launch' });
  return api;
}

const layout = () => document.querySelector('[data-layout]')?.getAttribute('data-layout');

describe('review layout by state', () => {
  it('ready: the variant plays large with its poster, Approve is the next step', async () => {
    await open(makeProject());
    expect(layout()).toBe('player');
    const player = screen.getByRole('region', { name: 'Video player' });
    const video = await within(player).findByLabelText('TikTok preview');
    expect(video).toHaveAttribute('src', 'https://cdn.test/render.mp4');
    await waitFor(() => expect(video).toHaveAttribute('poster', 'https://cdn.test/poster.jpg'));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Needs your attention/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Ready for review.');
  });

  it('draft: no player, the pipeline says how to begin, Generate is offered', async () => {
    await open(makeProject({ state: 'DRAFT', renders: [], scripts: [] }));
    expect(layout()).toBe('status');
    expect(screen.queryByRole('region', { name: 'Video player' })).toBeNull();
    expect(screen.getByText('Not started — Generate to begin.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });

  it('generating: a placeholder in the player, the live stage, and Cancel', async () => {
    await open(makeProject({ state: 'RENDERING', renders: [] }));
    expect(layout()).toBe('player');
    expect(
      screen.getByText('Your video appears here as soon as the first format is ready.'),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-live-stage="composing"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();
  });

  it('failed: the failure leads the attention list, the strip shows where it stopped', async () => {
    await open(
      makeProject({
        state: 'FAILED',
        errorReason: 'composition_failed',
        renders: [],
        metadata: { music: { status: 'failed', reason: null } },
      }),
    );
    expect(layout()).toBe('status');
    const list = screen.getByRole('region', { name: /Needs your attention/ });
    const rows = within(list).getAllByRole('button', { expanded: true });
    expect(rows[0]).toHaveTextContent('This video stopped before it was finished');
    expect(within(list).getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Stopped at the Render step.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate again/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 things need your attention');
  });

  it('published: the next step opens the Publish tab and keeps it in the URL', async () => {
    await open(makeProject({ state: 'PUBLISHED' }));
    await userEvent.click(screen.getByRole('button', { name: 'Posts and schedule' }));
    expect(screen.getByRole('tab', { name: 'Publish' })).toHaveAttribute('aria-selected', 'true');
    expect(nav.replace).toHaveBeenCalledWith('/projects/proj_1?tab=publish', { scroll: false });
  });
});

describe('Needs your attention', () => {
  it('starts warnings closed and opens them to the notice’s own panel', async () => {
    await open(makeProject({ metadata: { music: { status: 'failed', reason: 'quota' } } }));
    const row = screen.getByRole('button', { name: /Background music couldn’t be added/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('quota')).toBeNull();
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('quota')).toBeInTheDocument();
  });

  it('heads a list of notes only as “Good to know”', async () => {
    await open(
      makeProject({
        metadata: { fallbacks: [{ layer: 'voice', usedProviderId: 'azure', skipped: [] }] },
      }),
    );
    expect(screen.getByRole('heading', { name: /Good to know/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^Ready for review\.$/);
  });
});

describe('tabs in the URL', () => {
  it('opens the tab named in the link', async () => {
    nav.search = 'tab=script';
    await open(makeProject());
    expect(screen.getByRole('tab', { name: 'Script' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Spring is here. Three new plates.')).toBeInTheDocument();
  });

  it('ignores a tab this project does not have', async () => {
    nav.search = 'tab=slides';
    await open(makeProject());
    expect(screen.getByRole('tab', { name: 'Variants' })).toHaveAttribute('aria-selected', 'true');
  });

  it('replaces the URL on every switch, and the first tab keeps it clean', async () => {
    await open(makeProject());
    await userEvent.click(screen.getByRole('tab', { name: 'Shots' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/projects/proj_1?tab=shots', { scroll: false });
    await userEvent.click(screen.getByRole('tab', { name: 'Variants' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/projects/proj_1', { scroll: false });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('builds the query string without touching other parameters', () => {
    expect(withTab('a=1', 'publish', 'variants')).toBe('?a=1&tab=publish');
    expect(withTab('tab=publish&a=1', 'variants', 'variants')).toBe('?a=1');
    expect(withTab('', 'variants', 'variants')).toBe('');
    expect(resolveTab('nope', ['variants', 'shots'])).toBe('variants');
    expect(resolveTab('shots', ['variants', 'shots'])).toBe('shots');
  });
});

describe('player and actions', () => {
  it('switches the variant in the player from the format chips and from Watch', async () => {
    const renders = [
      makeRender(),
      makeRender({ id: 'ren_2', targetPlatform: 'youtube', aspectRatio: '16:9' }),
    ];
    await open(makeProject({ renders }));
    const player = screen.getByRole('region', { name: 'Video player' });
    await within(player).findByLabelText('TikTok preview');
    await userEvent.click(within(player).getByRole('radio', { name: /YouTube/ }));
    expect(await within(player).findByLabelText('YouTube preview')).toBeInTheDocument();
    const tiktok = screen.getByRole('article', { name: 'TikTok variant' });
    await userEvent.click(within(tiktok).getByRole('button', { name: 'Watch' }));
    expect(await within(player).findByLabelText('TikTok preview')).toBeInTheDocument();
    expect(within(tiktok).getByRole('button', { name: 'Playing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('duplicates from the actions menu and opens the copy', async () => {
    const api = await open(makeProject(), [
      {
        method: 'POST',
        match: '/projects/proj_1/duplicate',
        status: 201,
        body: { ok: true, project: { id: 'proj_copy' } },
      },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(api.find('POST', '/projects/proj_1/duplicate')).toHaveLength(1));
    expect(nav.push).toHaveBeenCalledWith('/projects/proj_copy');
    expect(toast.success).toHaveBeenCalledWith('Copy created.');
  });

  it('downloads the variant in the player from the actions menu', async () => {
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    await open(makeProject(), [
      {
        match: '/renders/ren_1/download',
        body: { ok: true, url: 'https://cdn.test/dl.mp4', expiresInSec: 60 },
      },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Download video' }));
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith('https://cdn.test/dl.mp4', '_blank', 'noopener'),
    );
  });
});
