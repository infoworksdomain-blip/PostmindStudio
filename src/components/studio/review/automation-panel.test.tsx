// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationPanel } from './automation-panel';
import { makeProject, mockFetch, renderWithSWR } from './test-helpers';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const connections = {
  ok: true,
  data: [{ id: 'conn_tt', businessId: 'biz_1', platform: 'tiktok', platformAccountName: 'Acme' }],
};

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('AutomationPanel', () => {
  it('says why an AUTO_APPROVE project still needs a person', () => {
    mockFetch([]);
    renderWithSWR(
      <AutomationPanel
        project={makeProject({
          reviewPolicy: 'AUTO_APPROVE',
          metadata: {
            review: {
              decision: 'needs_review',
              code: 'not_trusted',
              reason: 'Needs review: first 10 videos — 3 of 10 approved by a person so far',
              at: '2026-09-27T10:00:00Z',
            },
          },
        })}
      />,
    );
    // A record written before 17.9 (no params) keeps its stored English.
    expect(screen.getByRole('status')).toHaveTextContent('first 10 videos — 3 of 10');
  });

  it('17.9: words the reason from its code and params', () => {
    mockFetch([]);
    renderWithSWR(
      <AutomationPanel
        project={makeProject({
          reviewPolicy: 'AUTO_APPROVE',
          metadata: {
            review: {
              decision: 'needs_review',
              code: 'not_trusted',
              reason: 'English fallback',
              params: { approved: 3, needed: 10 },
              at: '2026-09-27T10:00:00Z',
            },
          },
        })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Needs review: your first 10 videos are reviewed by a person (3 of 10 approved so far).',
    );
  });

  it('distinguishes automatic from human approval', () => {
    mockFetch([]);
    const { unmount } = renderWithSWR(
      <AutomationPanel
        project={makeProject({
          state: 'APPROVED',
          approvals: [
            {
              id: 'a1',
              state: 'APPROVED',
              note: null,
              createdAt: '2026-09-27T10:00:00Z',
              resolvedByUserId: 'system:auto-approve',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/Approved automatically/)).toBeInTheDocument();
    unmount();
    renderWithSWR(
      <AutomationPanel
        project={makeProject({
          state: 'APPROVED',
          approvals: [
            {
              id: 'a2',
              state: 'APPROVED',
              note: null,
              createdAt: '2026-09-27T10:00:00Z',
              resolvedByUserId: 'user-9',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/Approved by a person/)).toBeInTheDocument();
  });

  it('lists auto-publish targets with per-target outcomes', async () => {
    mockFetch([{ match: '/platform-connections', body: connections }]);
    renderWithSWR(
      <AutomationPanel
        project={makeProject({
          state: 'PUBLISHING',
          publishPolicy: 'AUTO_ON_APPROVAL',
          metadata: {
            autoPublish: {
              targets: [
                { platform: 'tiktok', connectionId: 'conn_gone' },
                { platform: 'tiktok', connectionId: 'conn_tt' },
              ],
            },
            autoPublishResult: {
              at: '2026-09-27T10:00:00Z',
              trigger: 'auto',
              status: 'partial',
              results: [
                {
                  index: 0,
                  platform: 'tiktok',
                  account: 'conn_gone',
                  status: 'failed',
                  error: 'The tiktok connection needs reconnecting',
                },
                {
                  index: 1,
                  platform: 'tiktok',
                  account: 'conn_tt',
                  status: 'created',
                  publicationId: 'pub_1',
                  scheduledFor: null,
                },
              ],
            },
          },
        })}
      />,
    );
    const list = screen.getByRole('list', { name: 'Auto-publish targets' });
    expect(list).toHaveTextContent('Not published: The tiktok connection needs reconnecting');
    expect(list).toHaveTextContent('Sent to publish');
    await waitFor(() => expect(list).toHaveTextContent('TikTok · Acme'));
  });

  it('warns when auto-publish has no accounts', () => {
    mockFetch([]);
    renderWithSWR(<AutomationPanel project={makeProject({ publishPolicy: 'AUTO_ON_APPROVAL' })} />);
    expect(screen.getByText(/no accounts are chosen/)).toBeInTheDocument();
  });

  it('saves the project as a template', async () => {
    const api = mockFetch([
      {
        method: 'POST',
        match: '/templates',
        status: 201,
        body: { ok: true, template: { id: 't1' } },
      },
    ]);
    renderWithSWR(<AutomationPanel project={makeProject()} />);
    await userEvent.click(screen.getByRole('button', { name: /Save as template/ }));
    const category = screen.getByLabelText('Category');
    await userEvent.clear(category);
    await userEvent.type(category, 'Bad Cat');
    expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled();
    await userEvent.clear(category);
    await userEvent.type(category, 'launches');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(api.find('POST', '/templates')[0]?.body).toEqual({
      projectId: 'proj_1',
      name: 'Spring menu launch',
      category: 'launches',
    });
  });

  it('20.3: an approved SCHEDULED project with no free slot says so and can try again', async () => {
    const api = mockFetch([
      {
        method: 'POST',
        match: '/projects/proj_1/auto-publish/retry',
        status: 202,
        body: { ok: true, requeued: 0, scheduled: 1, unscheduled: null },
      },
    ]);
    const onChanged = vi.fn();
    renderWithSWR(
      <AutomationPanel
        onChanged={onChanged}
        project={makeProject({
          state: 'APPROVED',
          publishPolicy: 'SCHEDULED',
          metadata: {
            autoPublish: { targets: [{ platform: 'tiktok', connectionId: 'conn_tt' }] },
            scheduleIssue: { reason: 'no_free_slot', horizonDays: 56, at: '2026-09-30T10:00:00Z' },
          },
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No free posting time in the next 8 weeks — add posting times in the calendar and try again, or pick a date on the Publish tab.',
    );
    expect(screen.getByRole('link', { name: 'Open the calendar' })).toHaveAttribute(
      'href',
      '/calendar',
    );
    expect(screen.getByText('Scheduled automatically when approved')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.find('POST', '/projects/proj_1/auto-publish/retry')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('Scheduled 1 post.');
  });

  it('20.3: explains a queue that is off, and a retry that still finds nothing', async () => {
    mockFetch([
      {
        method: 'POST',
        match: '/projects/proj_1/auto-publish/retry',
        status: 202,
        body: { ok: true, requeued: 0, scheduled: 0, unscheduled: 'queue_off' },
      },
    ]);
    renderWithSWR(
      <AutomationPanel
        project={makeProject({
          state: 'APPROVED',
          publishPolicy: 'SCHEDULED',
          metadata: { scheduleIssue: { reason: 'queue_off', horizonDays: 56, at: 'x' } },
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Not scheduled: the drip queue is off.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Still no free posting time — add posting times or pick a date.',
      ),
    );
  });

  it('renders nothing for a slideshow draft with no automation', () => {
    mockFetch([]);
    const { container } = renderWithSWR(
      <AutomationPanel project={makeProject({ sourceType: 'SLIDESHOW', state: 'DRAFT' })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
