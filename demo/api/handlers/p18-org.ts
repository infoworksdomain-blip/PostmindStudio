// Phase 18 Track E sample handlers: the signed-in context and organisation settings. Shapes match
// the real routes:
//   GET /me                                       services/me.ts
//   GET|PATCH|DELETE /org, POST /org/transfer-ownership   services/org-settings.ts
//   GET|POST|PATCH|DELETE /members/**             services/members.ts (writes: Better Auth)
//   GET /audit                                    services/org-audit.ts
//   POST /organisations                           Track A (organisation create)
import { limits, meBilling } from '../billing-state';
import { DEMO_ORG_ID, DEMO_USER_ID, DEMO_USER_NAME } from '../ids';
import { DemoHttpError, route } from '../registry';
import { OTHER_ORGS } from './admin-state';
import { ago, DAY, HOUR } from './projects-store';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string, details?: Record<string, unknown>) =>
  new DemoHttpError(400, 'validation_error', message, details);

// ------------------------------------------------------------------ organisation

const org = {
  id: DEMO_ORG_ID,
  name: 'Leeds Sourdough Ltd',
  slug: 'leeds-sourdough',
  logo: null as string | null,
  country: 'GB' as string | null,
  defaultLocale: null as string | null,
  createdAt: ago(120 * DAY),
};

const yourRole = () => members.find((m) => m.userId === DEMO_USER_ID)?.role ?? 'owner';
const orgView = () => ({ ...org, yourRole: yourRole() });

// The plan line and the account banner (trial days left, past due with the grace date, read-only,
// no plan) follow the demo bar's plan switcher (../billing-state.ts).
route('GET', '/me', () => ({
  me: {
    user: {
      id: DEMO_USER_ID,
      name: DEMO_USER_NAME,
      email: 'amara@leedssourdough.example',
      platformRole: 'superadmin',
    },
    organisation: { id: org.id, name: org.name, role: yourRole() },
    organisations: [
      { id: org.id, name: org.name, role: yourRole() },
      { id: OTHER_ORGS.harrogate, name: 'Harrogate Coffee Co', role: 'creator' },
    ],
    ...meBilling(),
    impersonating: false,
    identityMode: 'standalone',
  },
}));

route('GET', '/org', () => ({ organisation: orgView() }));

route('PATCH', '/org', ({ body }) => {
  const input = obj(body);
  if (typeof input.name === 'string') {
    if (input.name.trim().length < 2) throw bad('name: Too small');
    org.name = input.name.trim();
  }
  if ('logo' in input) {
    if (input.logo !== null && !String(input.logo).startsWith('https://'))
      throw bad('logo: must be an https:// URL');
    org.logo = (input.logo as string | null) ?? null;
  }
  if ('country' in input) org.country = (input.country as string | null) ?? null;
  if ('defaultLocale' in input) org.defaultLocale = (input.defaultLocale as string | null) ?? null;
  return { organisation: orgView() };
});

route('DELETE', '/org', ({ body }) => {
  if (obj(body).confirmName !== org.name)
    throw bad('Type the organisation name exactly to confirm', { reason: 'name_mismatch' });
  throw new DemoHttpError(403, 'forbidden', 'Deleting the sample organisation is off in the demo.');
});

// Standalone mode re-authenticates (password) before the transfer; the demo accepts any password
// of 8+ characters and refuses a shorter one as a wrong password.
function demoReauth(body: unknown): void {
  const password = obj(body).password;
  if (typeof password !== 'string' || password.length === 0)
    throw new DemoHttpError(401, 'unauthorized', 'Enter your password', {
      reason: 'reauth_required',
    });
  if (password.length < 8)
    throw new DemoHttpError(401, 'unauthorized', 'That password is not right', {
      reason: 'reauth_failed',
    });
}

route('POST', '/org/transfer-ownership', ({ body }) => {
  demoReauth(body);
  const target = members.find((m) => m.id === obj(body).memberId);
  if (!target || target.userId === DEMO_USER_ID) throw bad('memberId: Invalid member');
  const me = members.find((m) => m.userId === DEMO_USER_ID);
  target.role = 'owner';
  if (me) me.role = 'admin';
  return { transferred: true };
});

route('POST', '/organisations', ({ body }) => {
  const name = String(obj(body).name ?? '').trim();
  if (name.length < 2) throw bad('name: Too small');
  return { status: 201, body: { organisation: { id: 'org-new', name, slug: 'new-org' } } };
});

/** POST /account/delete (p18-account.ts): the sole-owner rule and the demo re-authentication. */
export function accountDeletionCheck(body: unknown): void {
  demoReauth(body);
  const owners = members.filter((m) => m.role === 'owner');
  const others = members.filter((m) => m.userId !== DEMO_USER_ID);
  if (owners.length === 1 && owners[0]?.userId === DEMO_USER_ID && others.length > 0)
    throw new DemoHttpError(409, 'conflict', 'Transfer ownership first', {
      reason: 'sole_owner',
      organisations: [{ id: org.id, name: org.name }],
    });
}

// ------------------------------------------------------------------ members

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
  twoFactorEnabled: boolean;
}

const members: Member[] = [
  {
    id: 'mem-amara',
    userId: DEMO_USER_ID,
    name: DEMO_USER_NAME,
    email: 'amara@leedssourdough.example',
    role: 'owner',
    joinedAt: ago(120 * DAY),
    twoFactorEnabled: true,
  },
  {
    id: 'mem-tom',
    userId: 'user-tom',
    name: 'Tom Whitaker',
    email: 'tom@leedssourdough.example',
    role: 'admin',
    joinedAt: ago(90 * DAY),
    twoFactorEnabled: true,
  },
  {
    id: 'mem-priya',
    userId: 'user-priya',
    name: 'Priya Shah',
    email: 'priya@leedssourdough.example',
    role: 'publisher',
    joinedAt: ago(40 * DAY),
    twoFactorEnabled: false,
  },
  {
    id: 'mem-leo',
    userId: 'user-leo',
    name: 'Leo Grant',
    email: 'leo@leedssourdough.example',
    role: 'creator',
    joinedAt: ago(12 * DAY),
    twoFactorEnabled: false,
  },
];

interface Invite {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
  expiresAt: string;
}

const invitations: Invite[] = [
  {
    id: 'inv-sam',
    email: 'sam@leedssourdough.example',
    role: 'viewer',
    invitedAt: ago(2 * DAY),
    expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
  },
];

const ROLES = ['owner', 'admin', 'publisher', 'creator', 'viewer'];

/** Seats in use: members plus pending invitations (Better Auth's membershipLimit counts both). */
export function seatsUsed(): number {
  return members.length + invitations.length;
}

route('GET', '/members', () => ({
  members: members.map((m) => ({ ...m, isYou: m.userId === DEMO_USER_ID })),
  invitations,
  // The plan's seat limit (2 Basic, 5 Standard, 15 Plus, custom Enterprise) from the demo bar.
  seats: { used: seatsUsed(), limit: limits().seats },
  canManage: ['owner', 'admin'].includes(yourRole()),
}));

route('POST', '/members/invitations', ({ body }) => {
  const input = obj(body);
  const email = String(input.email ?? '')
    .trim()
    .toLowerCase();
  const role = String(input.role ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email: Invalid email address');
  if (!ROLES.includes(role) || role === 'owner') throw bad('role: Invalid option');
  if (members.some((m) => m.email === email))
    throw new DemoHttpError(409, 'conflict', 'Already a member', { reason: 'already_member' });
  const seatLimit = limits().seats;
  if (seatLimit !== null && seatsUsed() >= seatLimit)
    throw new DemoHttpError(403, 'quota_exceeded', 'Every seat on the plan is in use', {
      reason: 'seat_limit',
      resource: 'seats',
      limit: seatLimit,
    });
  const invite = {
    id: `inv-${Date.now()}`,
    email,
    role,
    invitedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
  };
  invitations.unshift(invite);
  return { status: 201, body: { invitation: { id: invite.id } } };
});

route('POST', '/members/invitations/:id/resend', ({ params }) => {
  const invite = invitations.find((i) => i.id === params.id);
  if (!invite) throw new DemoHttpError(404, 'not_found', 'Invitation not found');
  invite.expiresAt = new Date(Date.now() + 7 * DAY).toISOString();
  return { invitation: { id: invite.id } };
});

route('DELETE', '/members/invitations/:id', ({ params }) => {
  const i = invitations.findIndex((x) => x.id === params.id);
  if (i < 0) throw new DemoHttpError(404, 'not_found', 'Invitation not found');
  invitations.splice(i, 1);
  return { revoked: true };
});

const lastOwner = () =>
  new DemoHttpError(409, 'conflict', 'The last owner cannot be removed or demoted', {
    reason: 'last_owner',
  });

route('PATCH', '/members/:id', ({ params, body }) => {
  const member = members.find((m) => m.id === params.id);
  if (!member) throw new DemoHttpError(404, 'not_found', 'Member not found');
  const role = String(obj(body).role ?? '');
  if (!ROLES.includes(role)) throw bad('role: Invalid option');
  if (
    member.role === 'owner' &&
    role !== 'owner' &&
    members.filter((m) => m.role === 'owner').length <= 1
  )
    throw lastOwner();
  member.role = role;
  return { updated: true };
});

route('DELETE', '/members/:id', ({ params }) => {
  const i = members.findIndex((m) => m.id === params.id);
  const member = members[i];
  if (!member) throw new DemoHttpError(404, 'not_found', 'Member not found');
  if (member.role === 'owner' && members.filter((m) => m.role === 'owner').length <= 1)
    throw lastOwner();
  members.splice(i, 1);
  return { removed: true };
});

// ------------------------------------------------------------------ audit log

const AUDIT = [
  {
    action: 'member.invited',
    actorUserId: DEMO_USER_ID,
    resourceType: 'invitation',
    resourceId: 'inv-sam',
    at: 2 * DAY,
  },
  {
    action: 'member.role_changed',
    actorUserId: 'user-tom',
    resourceType: 'member',
    resourceId: 'mem-priya',
    at: 3 * DAY,
  },
  {
    action: 'meta.connected',
    actorUserId: DEMO_USER_ID,
    resourceType: 'platform_connection',
    resourceId: 'pc-instagram',
    at: 6 * DAY,
  },
  {
    action: 'billing.checkout_started',
    actorUserId: DEMO_USER_ID,
    resourceType: 'organisation',
    resourceId: DEMO_ORG_ID,
    at: 7 * DAY,
  },
  {
    action: 'billing.subscription_changed',
    actorUserId: null,
    resourceType: 'subscription',
    resourceId: 'sub_demo',
    at: 7 * DAY - HOUR,
    actorType: 'stripe',
  },
  {
    action: 'business.created',
    actorUserId: DEMO_USER_ID,
    resourceType: 'business',
    resourceId: 'biz-leeds-sourdough',
    at: 8 * DAY,
  },
  {
    action: 'member.joined',
    actorUserId: 'user-leo',
    resourceType: 'member',
    resourceId: 'mem-leo',
    at: 12 * DAY,
  },
  {
    action: 'auth.2fa_enabled',
    actorUserId: 'user-tom',
    resourceType: 'user',
    resourceId: 'user-tom',
    at: 20 * DAY,
  },
  {
    action: 'org.renamed',
    actorUserId: DEMO_USER_ID,
    resourceType: 'organisation',
    resourceId: DEMO_ORG_ID,
    at: 60 * DAY,
  },
  {
    action: 'org.created',
    actorUserId: DEMO_USER_ID,
    resourceType: 'organisation',
    resourceId: DEMO_ORG_ID,
    at: 120 * DAY,
  },
].map((a, i) => ({
  id: `aud-${i}`,
  occurredAt: ago(a.at),
  action: a.action,
  actorType: a.actorType ?? 'user',
  actorUserId: a.actorUserId,
  actorName: members.find((m) => m.userId === a.actorUserId)?.name ?? null,
  impersonatorUserId: null,
  resourceType: a.resourceType,
  resourceId: a.resourceId,
}));

route('GET', '/audit', ({ query }) => {
  const prefix = query.get('action') ?? '';
  const limit = Math.min(Number(query.get('limit') ?? 50) || 50, 100);
  const start = Number(query.get('cursor') ?? 0) || 0;
  const rows = AUDIT.filter((r) => r.action.startsWith(prefix));
  const page = rows.slice(start, start + limit);
  return { data: page, nextCursor: start + limit < rows.length ? String(start + limit) : null };
});
