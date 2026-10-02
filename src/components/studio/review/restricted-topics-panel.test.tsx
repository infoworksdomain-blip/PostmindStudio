// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { needsTopicConfirmation, RestrictedTopicsPanel } from './restricted-topics-panel';
import { makeProject, mockFetch, renderWithSWR, type MockRoute } from './test-helpers';

// BACKLOG 20.18 (spec 13.3) — the restricted-topics panel: the topics are listed; "Continue
// anyway" generates with confirmRestrictedTopics; the brief can be edited instead; viewers only
// read; errors stay on screen.

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
const generated: MockRoute = {
  method: 'POST',
  match: '/projects/proj_r/generate',
  status: 202,
  body: { ok: true, projectId: 'proj_r', state: 'QUEUED' },
};

const project = makeProject({
  id: 'proj_r',
  state: 'DRAFT',
  description: 'Election day offer for our members',
  errorReason: 'restricted_topics',
  pendingRestrictedTopics: ['politics', 'elections'],
  renders: [],
  scripts: [],
  brief: null,
});

describe('needsTopicConfirmation', () => {
  it('is true only for a DRAFT project whose reason is restricted_topics', () => {
    expect(needsTopicConfirmation(project)).toBe(true);
    expect(
      needsTopicConfirmation({
        state: 'DRAFT',
        errorReason: 'restricted_topics: user confirmation required (spec 13.3)',
      }),
    ).toBe(true);
    expect(needsTopicConfirmation({ ...project, state: 'FAILED' })).toBe(false);
    expect(needsTopicConfirmation({ ...project, errorReason: 'brief_too_vague' })).toBe(false);
  });
});

describe('RestrictedTopicsPanel', () => {
  it('lists the topics found', async () => {
    mockFetch([me(WRITER)]);
    renderWithSWR(<RestrictedTopicsPanel project={project} onChanged={vi.fn()} />);
    const panel = screen.getByRole('region', { name: 'Check the restricted topics' });
    expect(panel).toHaveTextContent(
      'Your brief touches topics your brand kit or business profile marks as restricted.',
    );
    const list = within(panel).getByRole('list', { name: 'Restricted topics found' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['politics', 'elections']);
  });

  it('"Continue anyway" generates with confirmRestrictedTopics', async () => {
    const onChanged = vi.fn();
    const fetch = mockFetch([me(WRITER), generated]);
    renderWithSWR(<RestrictedTopicsPanel project={project} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const call = fetch.find('POST', '/projects/proj_r/generate')[0];
    expect(call?.body).toEqual({ confirmRestrictedTopics: true });
    expect(call?.headers['idempotency-key']).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Generation started.');
  });

  it('"Generate with my changes" sends the edited brief without confirming', async () => {
    const onChanged = vi.fn();
    const fetch = mockFetch([me(WRITER), generated]);
    renderWithSWR(<RestrictedTopicsPanel project={project} onChanged={onChanged} />);
    const box = screen.getByLabelText('Your brief');
    expect(box).toHaveValue('Election day offer for our members');
    await userEvent.clear(box);
    await userEvent.type(box, 'A members-only autumn offer with free delivery this weekend');
    await userEvent.click(screen.getByRole('button', { name: 'Generate with my changes' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetch.find('POST', '/projects/proj_r/generate')[0]?.body).toEqual({
      rawInput: 'A members-only autumn offer with free delivery this weekend',
    });
  });

  it('keeps the panel and shows the error when generation cannot start', async () => {
    const onChanged = vi.fn();
    mockFetch([
      me(WRITER),
      { ...generated, status: 409, body: { ok: false, error: 'conflict', message: 'Changed' } },
    ]);
    renderWithSWR(<RestrictedTopicsPanel project={project} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));
    expect((await screen.findByRole('alert')).textContent).not.toBe('');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeEnabled();
  });

  it('a viewer sees the topics but no buttons or editor', async () => {
    mockFetch([me(['studio:project:read'])]);
    renderWithSWR(<RestrictedTopicsPanel project={project} onChanged={vi.fn()} />);
    await screen.findByText('Someone who can edit projects needs to continue or change the brief.');
    expect(screen.getByText('politics')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Your brief')).not.toBeInTheDocument();
  });

  it('is translated (de)', async () => {
    mockFetch([me(WRITER)]);
    renderWithSWR(
      withLocale('de', <RestrictedTopicsPanel project={project} onChanged={vi.fn()} />),
    );
    expect(
      await screen.findByRole('region', { name: 'Eingeschränkte Themen prüfen' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trotzdem fortfahren' })).toBeInTheDocument();
  });
});
