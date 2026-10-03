// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { DirectionsPanel, needsDirection } from './directions-panel';
import { makeProject, mockFetch, renderWithSWR, type MockRoute } from './test-helpers';

// BACKLOG 20.18 — the "choose a direction" panel: suggested directions start generation with
// directionChosen; the brief can be edited instead; viewers only read; errors stay on screen.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const me = (capabilities: string[]): MockRoute => ({
  match: '/me',
  body: { ok: true, me: { capabilities, user: { platformRole: 'user' } } },
});
const WRITER = ['studio:project:read', 'studio:project:write'];

const project = makeProject({
  id: 'proj_v',
  state: 'DRAFT',
  description: 'space video',
  errorReason: 'brief_too_vague',
  directionOptions: [
    'A countdown to our launch',
    'Three facts about space',
    'Behind the scenes of our studio',
  ],
  renders: [],
  scripts: [],
  brief: null,
});

describe('needsDirection', () => {
  it('is true only for a DRAFT project whose reason is brief_too_vague', () => {
    expect(needsDirection(project)).toBe(true);
    expect(
      needsDirection({
        state: 'DRAFT',
        errorReason: 'brief_too_vague: choose one of the suggested directions',
      }),
    ).toBe(true);
    expect(needsDirection({ ...project, state: 'QUEUED' })).toBe(false);
    expect(needsDirection({ ...project, errorReason: null })).toBe(false);
    expect(needsDirection({ ...project, errorReason: 'restricted_topics' })).toBe(false);
  });
});

describe('DirectionsPanel', () => {
  it('explains the problem and shows the three directions', async () => {
    mockFetch([me(WRITER)]);
    renderWithSWR(<DirectionsPanel project={project} onChanged={vi.fn()} />);
    const panel = screen.getByRole('region', { name: 'Choose a direction' });
    expect(panel).toHaveTextContent(
      'Your request is a bit too vague to make a good video. Pick one of these directions, or add more detail below.',
    );
    const list = within(panel).getByRole('list', { name: 'Suggested directions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list).toHaveTextContent('Three facts about space');
    expect(screen.getAllByRole('button', { name: /Use direction/ })).toHaveLength(3);
  });

  it('"Use this direction" generates with that direction and directionChosen', async () => {
    const onChanged = vi.fn();
    const fetch = mockFetch([
      me(WRITER),
      {
        method: 'POST',
        match: '/projects/proj_v/generate',
        status: 202,
        body: { ok: true, projectId: 'proj_v', state: 'QUEUED' },
      },
    ]);
    renderWithSWR(<DirectionsPanel project={project} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use direction 2' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const call = fetch.find('POST', '/projects/proj_v/generate')[0];
    expect(call?.body).toEqual({ rawInput: 'Three facts about space', directionChosen: true });
    expect(call?.headers['idempotency-key']).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Generation started.');
  });

  it('"Generate with my changes" sends the edited brief, and shows the hint while it is short', async () => {
    const onChanged = vi.fn();
    const fetch = mockFetch([
      me(WRITER),
      {
        method: 'POST',
        match: '/projects/proj_v/generate',
        status: 202,
        body: { ok: true, projectId: 'proj_v', state: 'QUEUED' },
      },
    ]);
    renderWithSWR(<DirectionsPanel project={project} onChanged={onChanged} />);
    const box = screen.getByLabelText('Your brief');
    expect(box).toHaveValue('space video');
    expect(screen.getByTestId('brief-hint')).toBeInTheDocument();
    await userEvent.clear(box);
    expect(screen.getByRole('button', { name: 'Generate with my changes' })).toBeDisabled();
    await userEvent.type(box, 'A space-themed launch teaser for our app aimed at startup founders');
    expect(screen.queryByTestId('brief-hint')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate with my changes' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetch.find('POST', '/projects/proj_v/generate')[0]?.body).toEqual({
      rawInput: 'A space-themed launch teaser for our app aimed at startup founders',
      directionChosen: true,
    });
  });

  it('keeps the panel and shows the error when generation cannot start', async () => {
    const onChanged = vi.fn();
    mockFetch([
      me(WRITER),
      {
        method: 'POST',
        match: '/projects/proj_v/generate',
        status: 403,
        body: { ok: false, error: 'quota_exceeded', message: 'Monthly video limit reached' },
      },
    ]);
    renderWithSWR(<DirectionsPanel project={project} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use direction 1' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toBe('');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use direction 1' })).toBeEnabled();
  });

  it('a viewer sees the directions but no buttons or editor', async () => {
    mockFetch([me(['studio:project:read'])]);
    renderWithSWR(<DirectionsPanel project={project} onChanged={vi.fn()} />);
    await screen.findByText(
      'Someone who can edit projects needs to choose a direction or add more detail.',
    );
    expect(screen.getByText('Three facts about space')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Your brief')).not.toBeInTheDocument();
  });

  it('works without suggestions (the editor is still there)', async () => {
    mockFetch([me(WRITER)]);
    renderWithSWR(
      <DirectionsPanel project={{ ...project, directionOptions: [] }} onChanged={vi.fn()} />,
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your brief')).toBeInTheDocument();
  });

  it('is translated (fr) and keeps the directions as written', async () => {
    mockFetch([me(WRITER)]);
    renderWithSWR(withLocale('fr', <DirectionsPanel project={project} onChanged={vi.fn()} />));
    expect(await screen.findByRole('region', { name: 'Choisissez une piste' })).toBeInTheDocument();
    expect(screen.getByText('A countdown to our launch')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Utiliser la piste/ })).toHaveLength(3);
  });
});
