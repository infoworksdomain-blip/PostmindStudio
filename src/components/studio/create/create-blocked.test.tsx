// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../review/test-helpers';
import { CreateScreen } from './create-screen';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/new' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// A read-only or plan-less organisation cannot create (402 from the access gate): Create says so
// up front, disables Generate with aria-describedby pointing at the reason, and links to billing.

function me(access: string): MockRoute {
  return {
    match: '/me',
    body: {
      ok: true,
      me: {
        user: { id: 'u1', name: 'A', email: 'a@b.c', platformRole: 'user' },
        organisation: { id: 'o1', name: 'Org', role: 'owner' },
        organisations: [],
        plan: { tier: 'STANDARD', access, source: 'stripe' },
        banner: null,
        impersonating: false,
        identityMode: 'standalone',
        capabilities: [],
      },
    },
  };
}

beforeEach(() => push.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('Create when the organisation cannot create', () => {
  it('read-only: Generate is disabled, described by the notice, with a billing link', async () => {
    const api = mockFetch([me('read_only')]);
    renderWithSWR(<CreateScreen initialReference={null} />);
    const notice = await screen.findByText(/Your account is read-only\. Update payment/);
    const button = screen.getByRole('button', { name: 'Generate' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', notice.closest('p')!.id);
    expect(screen.getByRole('link', { name: 'Update payment' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    expect(api.find('POST', '/projects')).toHaveLength(0);
  });

  it('no plan yet: Generate stays enabled (the click opens the choose-a-plan dialog)', async () => {
    mockFetch([me('none')]);
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Spring menu launch');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    expect(screen.queryByText(/read-only/)).not.toBeInTheDocument();
  });

  it('full access: Generate stays enabled and no notice is shown', async () => {
    mockFetch([me('full')]);
    renderWithSWR(<CreateScreen initialReference={null} />);
    await userEvent.type(screen.getByLabelText('What’s the video about?'), 'Spring menu launch');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    expect(screen.queryByText(/read-only/)).not.toBeInTheDocument();
  });
});
