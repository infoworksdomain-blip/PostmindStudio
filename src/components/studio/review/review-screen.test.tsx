// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewScreen } from './review-screen';
import { makeProject, makeRender, mockFetch, renderWithSWR, type MockRoute } from './test-helpers';
import type { ProjectDetail } from '@/lib/client/types';

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/projects/proj_1',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const meAs = (platformRole: string): MockRoute => ({
  match: '/me',
  body: {
    ok: true,
    me: {
      capabilities: ['studio:project:read', 'studio:project:write'],
      user: { platformRole },
    },
  },
});

function routes(project: ProjectDetail, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: `/projects/${project.id}`, body: { ok: true, project } },
    {
      match: /\/renders\/[^/]+\/preview$/,
      body: { ok: true, url: 'https://cdn.test/render.mp4', expiresInSec: 3600 },
    },
    { match: '/platform-connections', body: { ok: true, data: [] } },
  ];
}

beforeEach(() => {
  nav.search = '';
  nav.replace.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('ReviewScreen costs (operator decision 2026-10-04)', () => {
  it('shows customers no spend, budget or render cost', async () => {
    const api = mockFetch(
      routes(makeProject({ costBudgetPence: 350, renders: [makeRender()] }), [meAs('user')]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    await screen.findByRole('article', { name: 'TikTok variant' });
    await waitFor(() => expect(api.find('GET', '/me').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('project-spent')).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    expect(screen.queryByText(/spent|budget/i)).not.toBeInTheDocument();
  });

  it('shows staff the spend, the budget and each render’s cost', async () => {
    mockFetch(
      routes(makeProject({ costBudgetPence: 350, renders: [makeRender()] }), [meAs('staff')]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    expect(await screen.findByTestId('project-spent')).toHaveTextContent('£4.50 spent');
    expect(screen.getByText('of £3.50 budget')).toBeInTheDocument();
    const variant = screen.getByRole('article', { name: 'TikTok variant' });
    expect(variant).toHaveTextContent('£1.20');
  });

  // Needs review.actions.cancelledPlain from .i18n-tmp/frag-costs/en-GB.json.
  it('tells a customer the run was cancelled without saying what it cost', async () => {
    const api = mockFetch(
      routes(makeProject({ state: 'RENDERING', renders: [] }), [
        meAs('user'),
        {
          method: 'POST',
          match: '/projects/proj_1/cancel',
          body: { ok: true, projectId: 'proj_1', state: 'FAILED', costIncurredPence: 250 },
        },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    await waitFor(() => expect(api.find('GET', '/me').length).toBeGreaterThan(0));
    await userEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cancelled.'));
  });
});

describe('ReviewScreen', () => {
  it('shows a loading state, then the project and its variants', async () => {
    mockFetch(routes(makeProject()));
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    expect(screen.getByLabelText('Loading project')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Spring menu launch' })).toBeInTheDocument();
    expect(screen.getByText('Ready for review')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'TikTok variant' })).toBeInTheDocument();
    const player = screen.getByRole('region', { name: 'Video player' });
    const video = await within(player).findByLabelText('TikTok preview');
    expect(video).toHaveAttribute('src', 'https://cdn.test/render.mp4');
    expect(screen.getByRole('list', { name: 'Pipeline progress' })).toBeInTheDocument();
  });

  it('shows a not-found page with a way back for a missing project (no useless Retry)', async () => {
    mockFetch([
      {
        match: '/projects/nope',
        status: 404,
        body: { ok: false, error: 'not_found', message: 'Project not found' },
      },
    ]);
    renderWithSWR(<ReviewScreen projectId="nope" />);
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('shows an error state with retry when loading fails', async () => {
    mockFetch([
      {
        match: '/projects/boom',
        status: 500,
        body: { ok: false, error: 'internal', message: 'Database unavailable' },
      },
    ]);
    renderWithSWR(<ReviewScreen projectId="boom" />);
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('approves with an optional note', async () => {
    const project = makeProject();
    const api = mockFetch(
      routes(project, [
        {
          method: 'POST',
          match: '/projects/proj_1/approve',
          body: { ok: true, project: { ...project, state: 'APPROVED' } },
        },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'Looks great');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(api.find('POST', '/projects/proj_1/approve')).toHaveLength(1));
    expect(api.find('POST', '/projects/proj_1/approve')[0]?.body).toEqual({
      note: 'Looks great',
    });
    expect(toast.success).toHaveBeenCalledWith('Approved — ready to publish.');
  });

  it('Escape closes the reject form without rejecting and focus returns to Reject', async () => {
    const api = mockFetch(
      routes(makeProject(), [
        { method: 'POST', match: '/projects/proj_1/reject', body: { ok: true } },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    const reject = await screen.findByRole('button', { name: 'Reject' });
    await userEvent.click(reject);
    await userEvent.type(screen.getByLabelText(/What needs to change/), 'Draft{Escape}');
    expect(screen.queryByRole('button', { name: 'Confirm rejection' })).not.toBeInTheDocument();
    await waitFor(() => expect(reject).toHaveFocus());
    expect(api.find('POST', '/projects/proj_1/reject')).toHaveLength(0);
  });

  it('Escape also closes the form while focus is still on the Reject button', async () => {
    mockFetch(routes(makeProject()));
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    const reject = await screen.findByRole('button', { name: 'Reject' });
    reject.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Confirm rejection' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Confirm rejection' })).not.toBeInTheDocument();
    await waitFor(() => expect(reject).toHaveFocus());
  });

  it('requires a note to reject', async () => {
    const api = mockFetch(
      routes(makeProject(), [
        { method: 'POST', match: '/projects/proj_1/reject', body: { ok: true } },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/What needs to change/), 'Wrong price');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(api.find('POST', '/projects/proj_1/reject')[0]?.body).toEqual({
        note: 'Wrong price',
      }),
    );
  });

  it('offers cancel while the pipeline is working (staff see what the run cost)', async () => {
    const project = makeProject({ state: 'RENDERING', renders: [] });
    const api = mockFetch(
      routes(project, [
        meAs('staff'),
        {
          method: 'POST',
          match: '/projects/proj_1/cancel',
          body: { ok: true, projectId: 'proj_1', state: 'FAILED', costIncurredPence: 250 },
        },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    expect(
      await screen.findByText('Variants appear here as each format finishes rendering.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(api.find('POST', '/projects/proj_1/cancel')).toHaveLength(1));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Cancelled — £2.50 was spent on this run.'),
    );
  });

  it('starts generation for a draft', async () => {
    const api = mockFetch(
      routes(makeProject({ state: 'DRAFT', renders: [], scripts: [] }), [
        { method: 'POST', match: '/projects/proj_1/generate', status: 202, body: { ok: true } },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.find('POST', '/projects/proj_1/generate')[0]?.body).toEqual({}));
  });

  it('switches tabs with the keyboard and shows the script', async () => {
    mockFetch(routes(makeProject()));
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    const variants = await screen.findByRole('tab', { name: 'Variants' });
    variants.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Script' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Spring is here. Three new plates.')).toBeInTheDocument();
  });

  it('puts the slides tab first for slideshow projects', async () => {
    mockFetch(
      routes(makeProject({ sourceType: 'SLIDESHOW', state: 'DRAFT', renders: [] }), [
        { match: '/projects/proj_1/slides', body: { ok: true, data: [] } },
      ]),
    );
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    const tab = await screen.findByRole('tab', { name: 'Slides' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('No slides yet — add one below.')).toBeInTheDocument();
  });

  it('asks for approval before publishing', async () => {
    mockFetch(routes(makeProject({ renders: [makeRender()] })));
    renderWithSWR(<ReviewScreen projectId="proj_1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Publish' }));
    expect(screen.getByText('Approve the video before publishing it.')).toBeInTheDocument();
    expect(screen.getByText('Nothing published or scheduled yet.')).toBeInTheDocument();
  });
});
