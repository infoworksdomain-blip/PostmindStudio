// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '@/lib/client/types';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { AutoPublishOutbox } from './auto-publish-outbox';
import { AutoResumeNote, orgCapPause, SafetyReviewNote } from './paused-notes';

// Review screen additions from Phase 13 track A3: the auto-publish outbox with Retry (13.21),
// the org-cap pause note with the auto-resume switch (13.20) and the safety-review note (13.17).

// jsdom has no ResizeObserver; the Radix Switch measures with it.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

afterEach(() => vi.unstubAllGlobals());

const project = (over: Partial<ProjectDetail>): ProjectDetail =>
  ({
    id: 'prj-1',
    name: 'Valentine’s box',
    state: 'FAILED',
    errorReason: 'cost_cap_paused: organisation daily cost cap reached',
    metadata: { costPause: { scope: 'org_daily', period: '2026-09-28' } },
    ...over,
  }) as ProjectDetail;

describe('AutoPublishOutbox', () => {
  it('shows each target’s state and retries the failed ones', async () => {
    const { calls } = mockFetch([
      {
        match: '/projects/prj-1/auto-publish',
        body: {
          ok: true,
          outbox: [
            {
              id: 'a',
              targetIndex: 0,
              target: { platform: 'tiktok', account: 'c1', scheduleOffsetMinutes: null },
              state: 'SENT',
              attempts: 1,
              maxAttempts: 5,
              nextAttemptAt: null,
              lastError: null,
              publicationId: 'pub-1',
            },
            {
              id: 'b',
              targetIndex: 1,
              target: { platform: 'youtube_short', account: 'c2', scheduleOffsetMinutes: null },
              state: 'FAILED',
              attempts: 5,
              maxAttempts: 5,
              nextAttemptAt: null,
              lastError: 'The youtube connection needs reconnecting',
              publicationId: null,
            },
          ],
        },
      },
      {
        match: '/projects/prj-1/auto-publish/retry',
        method: 'POST',
        body: { ok: true, requeued: 1 },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<AutoPublishOutbox projectId="prj-1" />);
    expect(await screen.findByText('Sent to publish')).toBeInTheDocument();
    expect(
      screen.getByText(/Failed after 5 attempts — The youtube connection needs reconnecting/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry auto-publish/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  });

  it('renders nothing when the project was never auto-published', async () => {
    mockFetch([{ match: '/projects/prj-1/auto-publish', body: { ok: true, outbox: [] } }]);
    const { container } = renderWithSWR(<AutoPublishOutbox projectId="prj-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('AutoResumeNote', () => {
  it('detects only organisation daily / monthly pauses', () => {
    expect(orgCapPause(project({}))).toBe('org_daily');
    expect(orgCapPause(project({ metadata: { costPause: { scope: 'org_monthly' } } }))).toBe(
      'org_monthly',
    );
    expect(orgCapPause(project({ metadata: { costPause: { scope: 'project' } } }))).toBeNull();
    expect(orgCapPause(project({ state: 'READY_FOR_REVIEW' }))).toBeNull();
  });

  it('says when it resumes and turns auto-resume off', async () => {
    const { calls } = mockFetch([
      { match: '/projects/prj-1', method: 'PATCH', body: { ok: true, project: {} } },
    ]);
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderWithSWR(<AutoResumeNote project={project({})} onChanged={onChanged} />);
    expect(screen.getByText(/resumes automatically at 00:05 UTC/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Resume automatically' }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ autoResume: false }));
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText(/Automatic resume is off/)).toBeInTheDocument();
  });
});

describe('SafetyReviewNote', () => {
  it('shows while a review is pending only', () => {
    const { rerender } = renderWithSWR(
      <SafetyReviewNote
        project={project({
          state: 'QUALITY_CHECKING',
          metadata: { safetyReview: { state: 'PENDING' } },
        })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('content-safety review');
    rerender(
      <SafetyReviewNote
        project={project({
          state: 'READY_FOR_REVIEW',
          metadata: { safetyReview: { state: 'ALLOWED' } },
        })}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});
