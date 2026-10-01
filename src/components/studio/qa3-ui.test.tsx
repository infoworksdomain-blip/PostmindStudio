// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/client/api';
import { withLocale } from '../../../test/i18n-wrapper';
import { useMe } from './account/use-me';
import { UpgradeDialogHost } from './billing/upgrade-dialog';
import { FailureReason } from './failure-reason';
import { ErrorState } from './primitives';
import { ApprovalBar } from './review/project-actions';
import { QualityPanel } from './review/quality-panel';
import {
  makeProject,
  makeRender,
  mockFetch,
  renderWithSWR,
  type MockRoute,
} from './review/test-helpers';

// QA 3: what each role sees. Raw provider text is for staff only; Approve / Reject / Force-approve
// follow the API's capability check; a 404 is "not found" with a way back; the upgrade dialog does
// not ask for billing a role may not read.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => vi.unstubAllGlobals());

const me = (capabilities: string[], platformRole = 'user'): MockRoute => ({
  match: '/me',
  body: { ok: true, me: { capabilities, user: { platformRole } } },
});

const text = (c: HTMLElement) => c.textContent ?? '';

describe('FailureReason shows raw provider text to staff only', () => {
  const social = 'youtube_short/unavailable: connect ECONNREFUSED 10.0.0.1:443';
  const ai = 'runway/provider_unavailable: upstream said {"error":"host 10.1.1.1"}';

  it('a customer reads the sentence, never the hostname, IP or error code', async () => {
    mockFetch([me([])]);
    for (const reason of [social, ai]) {
      const { container, unmount } = renderWithSWR(
        withLocale('en-GB', <FailureReason reason={reason} />),
      );
      await waitFor(() => expect(text(container)).toContain('the service is unavailable'));
      expect(text(container)).not.toMatch(/ECONNREFUSED|10\.\d+\.\d+\.\d+|upstream said/);
      unmount();
    }
  });

  it('a reason with no known code is replaced by a generic sentence for customers', async () => {
    mockFetch([me([])]);
    const { container } = renderWithSWR(
      withLocale('en-GB', <FailureReason reason="getaddrinfo ENOTFOUND api.internal.example" />),
    );
    await waitFor(() => expect(text(container)).toContain('This step failed.'));
    expect(text(container)).not.toContain('ENOTFOUND');
  });

  it('platform staff still read the raw text', async () => {
    mockFetch([me([], 'staff')]);
    const { container } = renderWithSWR(withLocale('en-GB', <FailureReason reason={social} />));
    await waitFor(() => expect(text(container)).toContain('connect ECONNREFUSED 10.0.0.1:443'));
    const raw = renderWithSWR(
      withLocale('en-GB', <FailureReason reason="getaddrinfo ENOTFOUND x" />),
    );
    await waitFor(() => expect(text(raw.container)).toContain('getaddrinfo ENOTFOUND x'));
  });

  it('a reviewer note on a rejected project is customer text and stays visible', async () => {
    mockFetch([me([])]);
    const { container } = renderWithSWR(
      withLocale('en-GB', <FailureReason reason="rejected: Please fix the logo" />),
    );
    await waitFor(() => expect(text(container)).toContain('Please fix the logo'));
  });
});

describe('Approve and Reject follow the approve capability', () => {
  const project = makeProject({ state: 'READY_FOR_REVIEW' });

  it('a viewer sees why there are no buttons', async () => {
    mockFetch([me(['studio:project:read'])]);
    renderWithSWR(
      withLocale('en-GB', <ApprovalBar project={project} onChanged={() => undefined} />),
    );
    expect(
      await screen.findByText(/Only a publisher, admin or owner can approve or reject/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('a publisher keeps both buttons', async () => {
    mockFetch([me(['studio:project:read', 'studio:project:approve'])]);
    renderWithSWR(
      withLocale('en-GB', <ApprovalBar project={project} onChanged={() => undefined} />),
    );
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeVisible();
    expect(screen.queryByText(/Only a publisher/)).toBeNull();
  });

  it('force-approve needs its own capability', async () => {
    const failed = makeRender({ qualityCheckState: 'FAILED' });
    mockFetch([me(['studio:project:read', 'studio:project:approve'])]);
    const first = renderWithSWR(
      withLocale('en-GB', <QualityPanel render={failed} onChanged={() => undefined} />),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Force-approve' })).toBeNull());
    first.unmount();

    mockFetch([me(['studio:project:read', 'studio:render:force-approve'])]);
    renderWithSWR(
      withLocale('en-GB', <QualityPanel render={failed} onChanged={() => undefined} />),
    );
    expect(await screen.findByRole('button', { name: 'Force-approve' })).toBeVisible();
  });
});

describe('ErrorState for a missing record', () => {
  const copy = {
    title: 'Project not found',
    body: 'Gone.',
    href: '/projects',
    action: 'Back to projects',
  };

  it('a 404 says not found and links back, with no useless Retry', () => {
    renderWithSWR(
      withLocale(
        'en-GB',
        <ErrorState
          error={new ApiError(404, 'not_found', 'Project not found')}
          onRetry={() => undefined}
          notFound={copy}
        />,
      ),
    );
    expect(screen.getByText('Project not found')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('any other failure keeps the retryable error', () => {
    renderWithSWR(
      withLocale(
        'en-GB',
        <ErrorState
          error={new ApiError(500, 'internal', 'Boom')}
          onRetry={() => undefined}
          notFound={copy}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Back to projects' })).toBeNull();
  });
});

describe('UpgradeDialog without billing access', () => {
  it('does not request /billing for a role that cannot read it, and tells them to ask an owner', async () => {
    const calls = mockFetch([
      me(['studio:project:read']),
      {
        match: '/gated',
        method: 'POST',
        status: 403,
        body: {
          ok: false,
          error: 'plan_tier',
          message: 'blocked',
          details: { requiredTier: 'PLUS' },
        },
      },
      { match: '/billing/plans', body: { ok: true, pricing: { plans: [] } } },
    ]);
    // The app shell has loaded /me by the time any dialog opens; this stands in for it.
    function Shell() {
      return <span>{useMe().data ? 'me loaded' : 'me loading'}</span>;
    }
    renderWithSWR(
      withLocale(
        'en-GB',
        <>
          <Shell />
          <UpgradeDialogHost />
        </>,
      ),
    );
    await screen.findByText('me loaded');
    await act(async () => {
      await api('/gated', { method: 'POST', body: {} }).catch(() => undefined);
    });
    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(calls.calls.some((c) => c.path === '/billing')).toBe(false);
    expect(screen.getByText(/ask/i)).toBeVisible();
  });
});
