// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { AuditScreen } from './audit-screen';
import { MembersScreen, type MembersResponse } from './members-screen';
import { OrganisationSettingsScreen, type OrganisationResponse } from './organisation-settings';

// Phase 18 Track E — /settings/organisation, /settings/members and /settings/audit: role-aware
// controls, invites, last-owner errors, the seat meter, the audit filter, and ar / zh-Hans renders.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => '/settings/members' }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function org(yourRole: string): OrganisationResponse {
  return {
    ok: true,
    organisation: {
      id: 'org_1',
      name: 'Leeds Sourdough Ltd',
      slug: 'leeds',
      logo: null,
      country: 'GB',
      defaultLocale: null,
      createdAt: '2026-09-01T00:00:00Z',
      yourRole,
    },
  };
}

const members = (over: Partial<MembersResponse> = {}): MembersResponse => ({
  ok: true,
  canManage: true,
  seats: { used: 3, limit: 5 },
  members: [
    {
      id: 'm_owner',
      userId: 'u1',
      name: 'Ada Baker',
      email: 'ada@example.test',
      role: 'owner',
      joinedAt: '2026-09-01T00:00:00Z',
      twoFactorEnabled: true,
      isYou: true,
    },
    {
      id: 'm_creator',
      userId: 'u2',
      name: 'Ben Crust',
      email: 'ben@example.test',
      role: 'creator',
      joinedAt: '2026-09-02T00:00:00Z',
      twoFactorEnabled: false,
      isYou: false,
    },
  ],
  invitations: [
    {
      id: 'inv_1',
      email: 'cara@example.test',
      role: 'viewer',
      invitedAt: '2026-09-20T00:00:00Z',
      expiresAt: '2026-09-27T00:00:00Z',
    },
  ],
  ...over,
});

describe('OrganisationSettingsScreen', () => {
  it('lets an owner save details and shows transfer and delete', async () => {
    const api = mockFetch([
      { match: '/api/studio/org', method: 'PATCH', body: org('owner') },
      { match: '/api/studio/org', body: org('owner') },
      { match: '/api/studio/members', body: members() },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<OrganisationSettingsScreen />);
    const name = await screen.findByLabelText('Organisation name');
    await user.clear(name);
    await user.type(name, 'Leeds Sourdough');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Organisation details saved.'));
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      name: 'Leeds Sourdough',
      country: 'GB',
      logo: null,
    });
    expect(screen.getByRole('heading', { name: 'Transfer ownership' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete organisation…' })).toBeVisible();
  });

  it('delete needs the exact organisation name', async () => {
    mockFetch([
      { match: '/api/studio/org', body: org('owner') },
      { match: '/api/studio/members', body: members() },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<OrganisationSettingsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Delete organisation…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete organisation' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Leeds Sourdough Ltd');
    expect(confirm).toBeEnabled();
  });

  it('is read-only for creators, with no owner sections', async () => {
    mockFetch([{ match: '/api/studio/org', body: org('creator') }]);
    renderWithSWR(<OrganisationSettingsScreen />);
    expect(await screen.findByLabelText('Organisation name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Transfer ownership' })).toBeNull();
  });
});

describe('MembersScreen', () => {
  it('lists members, the seat meter and pending invitations', async () => {
    mockFetch([{ match: '/api/studio/members', body: members() }]);
    renderWithSWR(<MembersScreen />);
    expect(await screen.findByText('Ben Crust')).toBeVisible();
    expect(screen.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByText('cara@example.test')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Role for Ben Crust' })).toHaveValue('creator');
    // Ownership moves by transfer only: the creator select offers no Owner option.
    expect(
      within(screen.getByRole('combobox', { name: 'Role for Ben Crust' })).queryByRole('option', {
        name: 'Owner',
      }),
    ).toBeNull();
  });

  it('invites by email and role', async () => {
    const api = mockFetch([
      {
        match: '/members/invitations',
        method: 'POST',
        body: { ok: true, invitation: { id: 'x' } },
      },
      { match: '/api/studio/members', body: members() },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<MembersScreen />);
    await user.type(await screen.findByLabelText('Email address'), 'dan@example.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'publisher');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        email: 'dan@example.test',
        role: 'publisher',
      }),
    );
  });

  it('explains the last-owner rule when leaving is refused', async () => {
    mockFetch([
      {
        match: '/members/m_owner',
        method: 'DELETE',
        status: 409,
        body: { ok: false, error: 'conflict', message: 'x', details: { reason: 'last_owner' } },
      },
      { match: '/api/studio/members', body: members() },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<MembersScreen />);
    await user.click(await screen.findByRole('button', { name: 'Leave' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The last owner cannot leave or be demoted. Transfer ownership first.',
      ),
    );
  });

  it('blocks inviting at the seat limit and offers an upgrade', async () => {
    mockFetch([{ match: '/api/studio/members', body: members({ seats: { used: 5, limit: 5 } }) }]);
    renderWithSWR(<MembersScreen />);
    expect(await screen.findByText('Every seat on your plan is in use.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Upgrade for more seats' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    expect(screen.getByLabelText('Email address')).toBeDisabled();
  });

  it('explains a seat-limit refusal and refreshes the seat meter', async () => {
    const api = mockFetch([
      {
        match: '/members/invitations',
        method: 'POST',
        status: 403,
        body: {
          ok: false,
          error: 'quota_exceeded',
          message: 'Every seat on the plan is in use',
          details: { reason: 'seat_limit' },
        },
      },
      { match: '/api/studio/members', body: members() },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<MembersScreen />);
    await user.type(await screen.findByLabelText('Email address'), 'dan@example.test');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Every seat on your plan is in use. Upgrade for more seats, or remove someone first.',
      ),
    );
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/api/studio/members')).length).toBe(2),
    );
  });

  it('shows no management controls to a member without members:manage', async () => {
    mockFetch([
      { match: '/api/studio/members', body: members({ canManage: false, invitations: [] }) },
    ]);
    renderWithSWR(<MembersScreen />);
    expect(await screen.findByText('Ben Crust')).toBeVisible();
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Role for Ben Crust' })).toBeNull();
  });
});

const auditRoutes = (nextCursor: string | null): MockRoute[] => [
  {
    match: 'cursor=c1',
    body: {
      ok: true,
      nextCursor: null,
      data: [
        {
          id: 'a3',
          occurredAt: '2026-09-20T10:00:00Z',
          action: 'org.renamed',
          actorType: 'user',
          actorUserId: 'u1',
          actorName: 'Ada Baker',
          impersonatorUserId: null,
          resourceType: 'organisation',
          resourceId: 'org_1',
        },
      ],
    },
  },
  {
    match: '/api/studio/audit',
    body: {
      ok: true,
      nextCursor,
      data: [
        {
          id: 'a1',
          occurredAt: '2026-09-28T10:00:00Z',
          action: 'member.invited',
          actorType: 'user',
          actorUserId: 'u1',
          actorName: 'Ada Baker',
          impersonatorUserId: null,
          resourceType: 'invitation',
          resourceId: 'inv_1',
        },
        {
          id: 'a2',
          occurredAt: '2026-09-27T10:00:00Z',
          action: 'billing.something_new',
          actorType: 'stripe',
          actorUserId: null,
          actorName: null,
          impersonatorUserId: 'staff',
          resourceType: 'subscription',
          resourceId: 'sub_1',
        },
      ],
    },
  },
];

describe('AuditScreen', () => {
  it('shows known actions as sentences, unknown ones as codes, and loads more', async () => {
    const api = mockFetch(auditRoutes('c1'));
    const user = userEvent.setup();
    renderWithSWR(<AuditScreen />);
    expect(await screen.findByText('Invited a member')).toBeVisible();
    expect(screen.getByText('billing.something_new')).toBeVisible();
    expect(screen.getByText('Stripe')).toBeVisible();
    expect(screen.getByText('Staff view')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Renamed the organisation')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Show'), 'member.');
    await waitFor(() => expect(api.calls.some((c) => c.url.includes('action=member.'))).toBe(true));
  });
});

describe('settings screens localised', () => {
  it('render in Arabic (right to left) and Simplified Chinese', async () => {
    mockFetch([
      { match: '/api/studio/members', body: members() },
      { match: '/api/studio/org', body: org('owner') },
      ...auditRoutes(null),
    ]);
    const ar = renderWithSWR(withLocale('ar', <MembersScreen />));
    expect(await screen.findByRole('heading', { name: 'الأعضاء', level: 1 })).toBeVisible();
    expect(document.documentElement.dir).toBe('rtl');
    ar.unmount();
    const zh = renderWithSWR(withLocale('zh-Hans', <OrganisationSettingsScreen />));
    expect(await screen.findByDisplayValue('Leeds Sourdough Ltd')).toBeVisible();
    expect(document.documentElement.lang).toBe('zh-Hans');
    zh.unmount();
    renderWithSWR(withLocale('zh-Hans', <AuditScreen />));
    expect(await screen.findByText('Ada Baker')).toBeVisible();
  });
});
