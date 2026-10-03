// Phase 18 Track E sample handlers: the admin Organisations, Users and Subscriptions tabs and the
// legal-readiness warning. Shapes match services/admin-directory.ts and lib/legal/readiness.ts.
// Subscriptions are Track C's data (studio.subscriptions), shown read-only.
import { BILLING_STATE_INFO, getBillingState } from '../billing-state';
import { DEMO_ORG_ID, DEMO_USER_ID, DEMO_USER_NAME } from '../ids';
import { DemoHttpError, route } from '../registry';
import { OTHER_ORGS } from './admin-state';
import { planSummary } from './admin-plan-state';
import { ago, DAY } from './projects-store';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();

interface Org {
  id: string;
  name: string;
  slug: string;
  country: string;
  createdAt: string;
  deletedAt: string | null;
  members: number;
  tier: string | null;
  access: string | null;
  subscriptionStatus: string | null;
  costThisMonthPence: number;
  lookupKey: string | null;
}

const ORGS: Org[] = [
  {
    id: DEMO_ORG_ID,
    name: 'Leeds Sourdough Ltd',
    slug: 'leeds-sourdough',
    country: 'GB',
    createdAt: ago(120 * DAY),
    deletedAt: null,
    members: 4,
    tier: 'STANDARD',
    access: 'full',
    subscriptionStatus: 'trialing',
    costThisMonthPence: 1840,
    lookupKey: 'studio_standard_monthly',
  },
  {
    id: OTHER_ORGS.harrogate,
    name: 'Harrogate Coffee Co',
    slug: 'harrogate-coffee',
    country: 'GB',
    createdAt: ago(80 * DAY),
    deletedAt: null,
    members: 3,
    tier: 'PLUS',
    access: 'full',
    subscriptionStatus: 'active',
    costThisMonthPence: 6420,
    lookupKey: 'studio_plus_yearly',
  },
  {
    id: OTHER_ORGS.bramley,
    name: 'Bramley Florist',
    slug: 'bramley-florist',
    country: 'GB',
    createdAt: ago(60 * DAY),
    deletedAt: null,
    members: 2,
    tier: 'BASIC',
    access: 'full',
    subscriptionStatus: 'past_due',
    costThisMonthPence: 910,
    lookupKey: 'studio_basic_monthly',
  },
  {
    id: OTHER_ORGS.york,
    name: 'York Yoga Studio',
    slug: 'york-yoga',
    country: 'GB',
    createdAt: ago(45 * DAY),
    deletedAt: null,
    members: 1,
    tier: 'BASIC',
    access: 'read_only',
    subscriptionStatus: 'unpaid',
    costThisMonthPence: 0,
    lookupKey: 'studio_basic_monthly',
  },
  {
    // 20.27: the operator's own organisation on a Stripe trial, stuck just under the £15 trial
    // cap. Open it to see the trial and end it with a Plus override.
    id: OTHER_ORGS.platform,
    name: 'PostMind (operator)',
    slug: 'postmind-operator',
    country: 'GB',
    createdAt: ago(6 * DAY),
    deletedAt: null,
    members: 1,
    tier: 'STANDARD',
    access: 'full',
    subscriptionStatus: 'trialing',
    costThisMonthPence: 1_496,
    lookupKey: 'studio_plus_monthly',
  },
  {
    id: OTHER_ORGS.kirkstall,
    name: 'Kirkstall Barbers',
    slug: 'kirkstall-barbers',
    country: 'IE',
    createdAt: ago(5 * DAY),
    deletedAt: null,
    members: 1,
    tier: null,
    access: 'none',
    subscriptionStatus: null,
    costThisMonthPence: 0,
    lookupKey: null,
  },
];

export type AdminOrg = Org;
export const ADMIN_ORGS: readonly Org[] = ORGS;

/** The demo organisation's row follows the demo bar's plan switcher (../billing-state.ts). */
export function syncDemoOrg(): void {
  const row = ORGS.find((o) => o.id === DEMO_ORG_ID);
  if (!row) return;
  const state = getBillingState();
  const info = BILLING_STATE_INFO[state];
  row.tier = state === 'no_plan' ? null : info.tier;
  row.access = info.access;
  row.subscriptionStatus = info.status;
  row.lookupKey =
    info.tier === 'ENTERPRISE' || state === 'no_plan'
      ? null
      : `studio_${info.tier.toLowerCase()}_monthly`;
}

export const graceFor = (o: Org) => (o.subscriptionStatus === 'past_due' ? future(4) : null);

route('GET', '/admin/organisations', ({ query }) => {
  syncDemoOrg();
  const q = (query.get('q') ?? '').toLowerCase();
  const data = ORGS.filter(
    (o) => !q || o.name.toLowerCase().includes(q) || o.slug.includes(q) || o.id === q,
  );
  // 20.27: plan resolved with staff overrides, and the trial state; one page of 50.
  return {
    total: data.length,
    offset: 0,
    pageSize: 50,
    data: data.map(({ lookupKey: _k, ...o }) => ({ ...o, ...planSummary(o) })),
  };
});

route('GET', '/admin/organisations/:id', ({ params }) => {
  syncDemoOrg();
  const o = ORGS.find((x) => x.id === params.id);
  if (!o) throw new DemoHttpError(404, 'not_found', 'Organisation not found');
  return {
    organisation: {
      id: o.id,
      name: o.name,
      slug: o.slug,
      country: o.country,
      defaultLocale: 'en-GB',
      createdAt: o.createdAt,
      deletedAt: o.deletedAt,
    },
    members: [
      {
        id: `${o.id}-m1`,
        userId: o.id === DEMO_ORG_ID ? DEMO_USER_ID : `${o.id}-owner`,
        name: o.id === DEMO_ORG_ID ? DEMO_USER_NAME : 'Owner',
        email: `owner@${o.slug}.example`,
        role: 'owner',
        twoFactorEnabled: true,
        joinedAt: o.createdAt,
      },
    ],
    pendingInvitations: o.id === DEMO_ORG_ID ? 1 : 0,
    businesses: 1,
    entitlement: o.tier
      ? {
          ...planSummary(o),
          graceUntil: graceFor(o),
          trialStartedAt: o.subscriptionStatus === 'trialing' ? ago(5 * DAY) : null,
          everPaidAt: o.subscriptionStatus === 'trialing' ? null : ago(30 * DAY),
          reason: null,
          updatedAt: ago(DAY),
        }
      : null,
    subscriptions: o.subscriptionStatus
      ? [
          {
            id: `sub_${o.slug}`,
            organisationId: o.id,
            status: o.subscriptionStatus,
            lookupKey: o.lookupKey,
            interval: o.lookupKey?.endsWith('yearly') ? 'year' : 'month',
            currentPeriodEnd: future(20),
            cancelAtPeriodEnd: false,
            trialEnd: o.subscriptionStatus === 'trialing' ? future(9) : null,
            updatedAt: ago(DAY),
          },
        ]
      : [],
    costThisMonthPence: o.costThisMonthPence,
  };
});

route('GET', '/admin/subscriptions', ({ query }) => {
  syncDemoOrg();
  const status = query.get('status');
  const all = ORGS.filter((o) => o.subscriptionStatus);
  const rows = all.filter((o) => !status || o.subscriptionStatus === status);
  const byStatus: Record<string, number> = {};
  for (const o of all)
    byStatus[o.subscriptionStatus as string] = (byStatus[o.subscriptionStatus as string] ?? 0) + 1;
  return {
    total: rows.length,
    byStatus,
    data: rows.map((o) => ({
      id: `sub_${o.slug}`,
      organisationId: o.id,
      organisationName: o.name,
      status: o.subscriptionStatus,
      lookupKey: o.lookupKey,
      interval: o.lookupKey?.endsWith('yearly') ? 'year' : 'month',
      currentPeriodEnd: future(20),
      cancelAtPeriodEnd: o.id === OTHER_ORGS.harrogate,
      trialEnd: o.subscriptionStatus === 'trialing' ? future(9) : null,
      updatedAt: ago(DAY),
      graceUntil: graceFor(o),
    })),
  };
});

// ------------------------------------------------------------------ users

interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  role: string;
  banned: boolean;
  banReason: string | null;
  createdAt: string;
  deletedAt: null;
  sessions: number;
  organisations: number;
}

const USERS: User[] = [
  {
    id: DEMO_USER_ID,
    name: DEMO_USER_NAME,
    email: 'amara@leedssourdough.example',
    emailVerified: true,
    twoFactorEnabled: true,
    role: 'superadmin',
    banned: false,
    banReason: null,
    createdAt: ago(120 * DAY),
    deletedAt: null,
    sessions: 2,
    organisations: 2,
  },
  {
    id: 'user-tom',
    name: 'Tom Whitaker',
    email: 'tom@leedssourdough.example',
    emailVerified: true,
    twoFactorEnabled: true,
    role: 'user',
    banned: false,
    banReason: null,
    createdAt: ago(90 * DAY),
    deletedAt: null,
    sessions: 1,
    organisations: 1,
  },
  {
    id: 'user-priya',
    name: 'Priya Shah',
    email: 'priya@leedssourdough.example',
    emailVerified: true,
    twoFactorEnabled: false,
    role: 'user',
    banned: false,
    banReason: null,
    createdAt: ago(40 * DAY),
    deletedAt: null,
    sessions: 3,
    organisations: 1,
  },
  {
    id: 'user-spam',
    name: 'Quick Cash Deals',
    email: 'deals@spam.example',
    emailVerified: false,
    twoFactorEnabled: false,
    role: 'user',
    banned: true,
    banReason: 'Spam sign-ups',
    createdAt: ago(3 * DAY),
    deletedAt: null,
    sessions: 0,
    organisations: 1,
  },
];

const findUser = (id: string | undefined) => {
  const user = USERS.find((u) => u.id === id);
  if (!user) throw new DemoHttpError(404, 'not_found', 'User not found');
  return user;
};

const needReason = (body: unknown) => {
  const reason = String(obj(body).reason ?? '').trim();
  if (reason.length < 3) throw new DemoHttpError(400, 'validation_error', 'reason: Too small');
  return reason;
};

route('GET', '/admin/users', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase();
  const data = USERS.filter(
    (u) => !q || u.email.includes(q) || u.name.toLowerCase().includes(q) || u.id === q,
  );
  return { total: data.length, data };
});

route('GET', '/admin/users/:id', ({ params }) => {
  const user = findUser(params.id);
  return {
    user,
    memberships:
      user.id === DEMO_USER_ID
        ? [
            { organisationId: DEMO_ORG_ID, organisationName: 'Leeds Sourdough Ltd', role: 'owner' },
            {
              organisationId: OTHER_ORGS.harrogate,
              organisationName: 'Harrogate Coffee Co',
              role: 'creator',
            },
          ]
        : [
            {
              organisationId: DEMO_ORG_ID,
              organisationName: 'Leeds Sourdough Ltd',
              role: 'creator',
            },
          ],
    // Impersonation is off by default (STUDIO_IMPERSONATION_ENABLED=false).
    impersonation: false,
  };
});

const staffGuard = (user: User) => {
  if (user.role !== 'user')
    throw new DemoHttpError(
      403,
      'forbidden',
      'Staff accounts are managed with the superadmin CLI',
      { reason: 'target_is_staff' },
    );
};

route('POST', '/admin/users/:id/ban', ({ params, body }) => {
  const user = findUser(params.id);
  staffGuard(user);
  const reason = needReason(body);
  const banned = obj(body).banned === true;
  user.banned = banned;
  user.banReason = banned ? reason : null;
  const sessionsRevoked = banned ? user.sessions : 0;
  if (banned) user.sessions = 0;
  return { banned, sessionsRevoked };
});

route('DELETE', '/admin/users/:id/sessions', ({ params, body }) => {
  const user = findUser(params.id);
  needReason(body);
  const revoked = user.sessions;
  user.sessions = 0;
  return { revoked };
});

route('DELETE', '/admin/users/:id/two-factor', ({ params, body }) => {
  const user = findUser(params.id);
  staffGuard(user);
  needReason(body);
  user.twoFactorEnabled = false;
  user.sessions = 0;
  return { reset: true };
});

route('POST', '/admin/users/:id/impersonate', () => {
  throw new DemoHttpError(403, 'forbidden', 'Impersonation is switched off', {
    reason: 'impersonation_disabled',
  });
});

// ------------------------------------------------------------------ legal readiness

// Live's legal pages are published (finished text, no fill-in markers), so sign-up is open.
route('GET', '/admin/legal-readiness', () => ({
  readiness: {
    ready: true,
    launchBlockers: [],
    docs: ['terms', 'privacy', 'cookies', 'acceptable-use', 'dpa', 'subprocessors'].map((doc) => ({
      doc,
      present: true,
      placeholder: false,
      state: 'ready',
      unfilled: [],
    })),
  },
  signups: { open: true },
}));
