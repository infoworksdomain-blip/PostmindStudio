import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auditRoute from '../../src/app/api/studio/audit/route';
import * as meRoute from '../../src/app/api/studio/me/route';
import * as memberRoute from '../../src/app/api/studio/members/[id]/route';
import * as invitationRoute from '../../src/app/api/studio/members/invitations/[id]/route';
import * as resendRoute from '../../src/app/api/studio/members/invitations/[id]/resend/route';
import * as invitationsRoute from '../../src/app/api/studio/members/invitations/route';
import * as membersRoute from '../../src/app/api/studio/members/route';
import * as orgRoute from '../../src/app/api/studio/org/route';
import * as transferRoute from '../../src/app/api/studio/org/transfer-ownership/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { EntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import {
  setMembershipGateway,
  type MembershipGateway,
} from '../../src/lib/studio/services/membership-gateway';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi } from '../helpers/api-harness';
import { ForbiddenError } from '../../src/lib/errors';

// §5.11: organisation deletion and ownership transfer re-authenticate (auth/reauth.ts reads the
// Better Auth session; here the password check is stubbed: only PASSWORD is accepted).
const PASSWORD = 'correct horse battery';
const reauth = vi.hoisted(() => ({
  fn: vi.fn(async (_req: Pick<Request, 'headers'>, _password: string | undefined) => undefined),
}));
vi.mock('../../src/lib/auth/reauth', () => ({ reauthenticateRequest: reauth.fn }));

// Phase 18 Track E — /api/studio/{me,org,org/transfer-ownership,members/**,audit}: role rules
// (admins cannot touch owners, last-owner protection), the Better Auth gateway receives the
// writes, cross-organisation isolation on every id-taking route, audit scoping, and the
// account-state banner in /me.

const hasDb = Boolean(process.env.DATABASE_URL);

const ORG_CAPS: Record<string, string[]> = {
  owner: [
    'studio:project:read',
    'studio:org:manage',
    'studio:org:delete',
    'studio:members:manage',
    'studio:audit:read',
  ],
  admin: ['studio:project:read', 'studio:org:manage', 'studio:members:manage', 'studio:audit:read'],
  creator: ['studio:project:read', 'studio:project:write'],
};

function member(orgId: string, userId: string, role: keyof typeof ORG_CAPS): TenantContext {
  return {
    userId,
    organisationId: orgId,
    organisation: { id: orgId },
    memberships: [{ organisationId: orgId, role }],
    capabilities: ORG_CAPS[role] ?? [],
    role,
    platformRole: 'user',
  };
}

describe.skipIf(!hasDb)('org settings, members and audit API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const run = randomUUID().slice(0, 8);
  const orgA = `p18e-org-a-${run}`;
  const orgB = `p18e-org-b-${run}`;
  const u = (n: string) => `p18e-${n}-${run}`;
  const ids = {
    owner: u('owner'),
    admin: u('admin'),
    creator: u('creator'),
    outsider: u('outsider'),
  };
  const memberIds = { owner: '', admin: '', creator: '', outsider: '' };
  let invitationA = '';
  let invitationB = '';
  const gateway = {
    createInvitation: vi.fn(async (_h: Headers, _i: unknown) => ({ id: 'inv-new' })),
    cancelInvitation: vi.fn(async (_h: Headers, _i: unknown) => undefined),
    updateMemberRole: vi.fn(async (_h: Headers, _i: unknown) => undefined),
    removeMember: vi.fn(async (_h: Headers, _i: unknown) => undefined),
  } satisfies MembershipGateway;
  const tokens = {
    owner: member(orgA, ids.owner, 'owner'),
    admin: member(orgA, ids.admin, 'admin'),
    creator: member(orgA, ids.creator, 'creator'),
    outsider: member(orgB, ids.outsider, 'owner'),
  };
  let api: ReturnType<typeof installApi>;

  beforeAll(async () => {
    reauth.fn.mockImplementation(async (_req, password) => {
      if (password !== PASSWORD)
        throw new ForbiddenError('Password is incorrect', { reason: 'reauth_failed' });
    });
    for (const [key, id] of Object.entries(ids))
      await db.user.create({
        data: { id, name: `User ${key}`, email: `${id}@example.test`, emailVerified: true },
      });
    await db.organization.create({ data: { id: orgA, name: 'Bakery A', slug: orgA } });
    await db.organization.create({ data: { id: orgB, name: 'Bakery B', slug: orgB } });
    for (const [key, role] of [
      ['owner', 'owner'],
      ['admin', 'admin'],
      ['creator', 'creator'],
    ] as const) {
      const m = await db.member.create({
        data: { id: u(`m-${key}`), organizationId: orgA, userId: ids[key], role },
      });
      memberIds[key] = m.id;
    }
    const outsider = await db.member.create({
      data: { id: u('m-outsider'), organizationId: orgB, userId: ids.outsider, role: 'owner' },
    });
    memberIds.outsider = outsider.id;
    const week = new Date(Date.now() + 7 * 86_400_000);
    invitationA = (
      await db.invitation.create({
        data: {
          id: u('inv-a'),
          organizationId: orgA,
          email: 'new@example.test',
          role: 'creator',
          expiresAt: week,
          inviterId: ids.owner,
        },
      })
    ).id;
    invitationB = (
      await db.invitation.create({
        data: {
          id: u('inv-b'),
          organizationId: orgB,
          email: 'other@example.test',
          role: 'viewer',
          expiresAt: week,
          inviterId: ids.outsider,
        },
      })
    ).id;
    // Expired invitations are not listed.
    await db.invitation.create({
      data: {
        id: u('inv-old'),
        organizationId: orgA,
        email: 'old@example.test',
        role: 'viewer',
        expiresAt: new Date(Date.now() - 1000),
        inviterId: ids.owner,
      },
    });
    await db.auditLog.createMany({
      data: [
        {
          actorUserId: ids.owner,
          actorType: 'user',
          organisationId: orgA,
          action: 'member.invited',
          resourceType: 'invitation',
          resourceId: invitationA,
          occurredAt: new Date(Date.now() - 3000),
        },
        {
          actorUserId: ids.owner,
          actorType: 'user',
          organisationId: orgA,
          action: 'org.renamed',
          resourceType: 'organisation',
          resourceId: orgA,
          occurredAt: new Date(Date.now() - 2000),
        },
        {
          actorUserId: ids.admin,
          actorType: 'user',
          organisationId: orgA,
          action: 'member.role_changed',
          resourceType: 'member',
          resourceId: 'x',
          occurredAt: new Date(Date.now() - 1000),
        },
        {
          actorUserId: ids.outsider,
          actorType: 'user',
          organisationId: orgB,
          action: 'member.invited',
          resourceType: 'invitation',
          resourceId: invitationB,
        },
      ],
    });
  });

  beforeEach(() => {
    api = installApi(db, tokens);
    setMembershipGateway(gateway);
    for (const fn of Object.values(gateway)) fn.mockClear();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    setMembershipGateway(undefined);
    await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await db.$disconnect();
  });

  describe('GET /me', () => {
    it('returns the user, the active organisation and its switcher list', async () => {
      const res = await call(meRoute.GET, { token: 'admin' });
      expect(res.status).toBe(200);
      expect(res.json.me).toMatchObject({
        user: { id: ids.admin, name: 'User admin', email: `${ids.admin}@example.test` },
        organisation: { id: orgA, name: 'Bakery A', role: 'admin' },
        organisations: [{ id: orgA, name: 'Bakery A', role: 'admin' }],
        impersonating: false,
      });
    });

    it('shows the no-plan banner from the entitlements reader', async () => {
      const entitlements: EntitlementsReader = {
        forOrganisation: async () => ({
          tier: 'BASIC',
          access: 'none',
          source: 'none',
          limits: { seats: 2, businesses: 1, storageGb: 25 },
        }),
        invalidate: () => undefined,
      };
      api.deps.entitlements = entitlements;
      const res = await call(meRoute.GET, { token: 'owner' });
      expect(res.json.me).toMatchObject({ banner: { kind: 'no_plan' }, plan: { access: 'none' } });
    });

    it('a cancelled organisation gets the "subscription ended" banner with its deletion date (19.5)', async () => {
      const subId = `sub_p18e_${run}`;
      await db.subscription.create({
        data: {
          id: subId,
          organisationId: orgA,
          stripeCustomerId: `cus_p18e_${run}`,
          status: 'canceled',
        },
      });
      await db.orgEntitlement.upsert({
        where: { organisationId: orgA },
        create: {
          organisationId: orgA,
          tier: 'BASIC',
          access: 'read_only',
          source: 'stripe',
          everPaidAt: new Date('2026-06-01T00:00:00Z'),
          overrides: { retention: { cancelledAt: '2026-10-01T00:00:00.000Z' } },
        },
        update: { overrides: { retention: { cancelledAt: '2026-10-01T00:00:00.000Z' } } },
      });
      api.deps.entitlements = {
        forOrganisation: async () => ({
          tier: 'BASIC',
          access: 'read_only',
          source: 'stripe',
          limits: { seats: 2, businesses: 1, storageGb: 25 },
        }),
        invalidate: () => undefined,
      };
      try {
        const res = await call(meRoute.GET, { token: 'owner' });
        expect(res.json.me).toMatchObject({
          banner: { kind: 'cancelled', deletesAt: '2026-12-30T00:00:00.000Z' },
        });
      } finally {
        await db.subscription.delete({ where: { id: subId } });
        await db.orgEntitlement.delete({ where: { organisationId: orgA } });
      }
    });

    it('401 without a session', async () => {
      expect((await call(meRoute.GET)).status).toBe(401);
    });
  });

  describe('/org', () => {
    it('any member reads the organisation', async () => {
      const res = await call(orgRoute.GET, { token: 'creator' });
      expect(res.json.organisation).toMatchObject({
        id: orgA,
        name: 'Bakery A',
        yourRole: 'creator',
      });
    });

    it('creators cannot change it; admins can, and it is audited', async () => {
      const denied = await call(orgRoute.PATCH, {
        method: 'PATCH',
        token: 'creator',
        body: { name: 'Nope' },
      });
      expect(denied.status).toBe(403);
      const res = await call(orgRoute.PATCH, {
        method: 'PATCH',
        token: 'admin',
        body: { name: 'Bakery A Ltd', country: 'gb', defaultLocale: 'fr' },
      });
      expect(res.status).toBe(200);
      expect(res.json.organisation).toMatchObject({
        name: 'Bakery A Ltd',
        country: 'GB',
        defaultLocale: 'fr',
      });
      expect(api.audits.at(-1)).toMatchObject({ action: 'org.renamed', organisationId: orgA });
      await db.organization.update({ where: { id: orgA }, data: { name: 'Bakery A' } });
    });

    it('rejects an http logo and an unknown locale', async () => {
      for (const body of [{ logo: 'http://x.test/a.png' }, { defaultLocale: 'xx' }]) {
        const res = await call(orgRoute.PATCH, { method: 'PATCH', token: 'owner', body });
        expect(res.status).toBe(400);
      }
    });

    it('delete is owner-only and needs the exact name', async () => {
      const admin = await call(orgRoute.DELETE, {
        method: 'DELETE',
        token: 'admin',
        body: { confirmName: 'Bakery A' },
      });
      expect(admin.status).toBe(403);
      const wrong = await call(orgRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        body: { confirmName: 'bakery a', password: PASSWORD },
      });
      expect(wrong.status).toBe(400);
      expect(await db.organization.findUnique({ where: { id: orgA } })).toMatchObject({
        deletedAt: null,
      });
    });

    it('delete re-authenticates the owner first (§5.11)', async () => {
      for (const body of [
        { confirmName: 'Bakery A' },
        { confirmName: 'Bakery A', password: 'x' },
      ]) {
        const res = await call(orgRoute.DELETE, { method: 'DELETE', token: 'owner', body });
        expect(res.status).toBe(403);
        expect(res.json).toMatchObject({ details: { reason: 'reauth_failed' } });
      }
      expect(reauth.fn).toHaveBeenLastCalledWith(expect.anything(), 'x');
      expect(await db.organization.findUnique({ where: { id: orgA } })).toMatchObject({
        deletedAt: null,
      });
    });
  });

  describe('transfer ownership', () => {
    it('only an owner transfers; the target is promoted before the owner steps down', async () => {
      const denied = await call(transferRoute.POST, {
        method: 'POST',
        token: 'admin',
        body: { memberId: memberIds.creator },
      });
      expect(denied.status).toBe(403);
      const unconfirmed = await call(transferRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { memberId: memberIds.admin, password: 'wrong' },
      });
      expect(unconfirmed.status).toBe(403);
      expect(gateway.updateMemberRole).not.toHaveBeenCalled();
      const res = await call(transferRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { memberId: memberIds.admin, password: PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(gateway.updateMemberRole.mock.calls.map((c) => c[1])).toEqual([
        { organisationId: orgA, memberId: memberIds.admin, role: 'owner' },
        { organisationId: orgA, memberId: memberIds.owner, role: 'admin' },
      ]);
    });

    it('a member of another organisation is not found', async () => {
      const res = await call(transferRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { memberId: memberIds.outsider, password: PASSWORD },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('members', () => {
    it('lists members, live pending invitations and the seat meter', async () => {
      const res = await call(membersRoute.GET, { token: 'owner' });
      expect(res.status).toBe(200);
      const members = res.json.members as Array<{ userId: string; role: string; isYou: boolean }>;
      expect(members.map((m) => m.role)).toEqual(['owner', 'admin', 'creator']);
      expect(members.find((m) => m.isYou)?.userId).toBe(ids.owner);
      expect((res.json.invitations as Array<{ id: string }>).map((i) => i.id)).toEqual([
        invitationA,
      ]);
      expect(res.json.seats).toEqual({ used: 4, limit: null });
    });

    it('hides invitations from members who cannot manage them', async () => {
      const res = await call(membersRoute.GET, { token: 'creator' });
      expect(res.json).toMatchObject({ invitations: [], canManage: false });
    });

    it('an admin cannot demote or remove an owner, nor grant ownership', async () => {
      const demote = await call(memberRoute.PATCH, {
        method: 'PATCH',
        token: 'admin',
        params: { id: memberIds.owner },
        body: { role: 'viewer' },
      });
      expect(demote.status).toBe(403);
      const grant = await call(memberRoute.PATCH, {
        method: 'PATCH',
        token: 'admin',
        params: { id: memberIds.creator },
        body: { role: 'owner' },
      });
      expect(grant.status).toBe(403);
      const remove = await call(memberRoute.DELETE, {
        method: 'DELETE',
        token: 'admin',
        params: { id: memberIds.owner },
      });
      expect(remove.status).toBe(403);
      expect(gateway.updateMemberRole).not.toHaveBeenCalled();
      expect(gateway.removeMember).not.toHaveBeenCalled();
    });

    it('the last owner cannot demote or remove themselves', async () => {
      const demote = await call(memberRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id: memberIds.owner },
        body: { role: 'admin' },
      });
      expect(demote.status).toBe(409);
      expect(demote.json.details).toEqual({ reason: 'last_owner' });
      const leave = await call(memberRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id: memberIds.owner },
      });
      expect(leave.status).toBe(409);
    });

    it('an admin changes a creator’s role through the gateway', async () => {
      const res = await call(memberRoute.PATCH, {
        method: 'PATCH',
        token: 'admin',
        params: { id: memberIds.creator },
        body: { role: 'publisher' },
      });
      expect(res.status).toBe(200);
      expect(gateway.updateMemberRole).toHaveBeenCalledWith(expect.any(Headers), {
        organisationId: orgA,
        memberId: memberIds.creator,
        role: 'publisher',
      });
    });

    it('another organisation’s member is a 404 (cross-org)', async () => {
      for (const res of [
        await call(memberRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id: memberIds.outsider },
          body: { role: 'viewer' },
        }),
        await call(memberRoute.DELETE, {
          method: 'DELETE',
          token: 'owner',
          params: { id: memberIds.outsider },
        }),
      ])
        expect(res.status).toBe(404);
    });

    it('creators cannot manage members', async () => {
      const res = await call(memberRoute.DELETE, {
        method: 'DELETE',
        token: 'creator',
        params: { id: memberIds.admin },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('invitations', () => {
    it('invites by email and role through the gateway (never as owner)', async () => {
      const res = await call(invitationsRoute.POST, {
        method: 'POST',
        token: 'admin',
        body: { email: ' Someone@Example.test ', role: 'viewer' },
      });
      expect(res.status).toBe(201);
      expect(gateway.createInvitation).toHaveBeenCalledWith(expect.any(Headers), {
        organisationId: orgA,
        email: 'someone@example.test',
        role: 'viewer',
      });
      const owner = await call(invitationsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { email: 'x@example.test', role: 'owner' },
      });
      expect(owner.status).toBe(400);
    });

    it('refuses to invite when members plus pending invitations fill the plan (seat limit)', async () => {
      api.deps.entitlements = {
        forOrganisation: async () => ({
          tier: 'BASIC',
          access: 'full',
          source: 'stripe',
          limits: { seats: 4, businesses: 1, storageGb: 25 },
        }),
        invalidate: () => undefined,
      };
      const res = await call(invitationsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { email: 'fifth@example.test', role: 'viewer' },
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        error: 'quota_exceeded',
        details: { reason: 'seat_limit', used: 4, limit: 4 },
      });
      expect(gateway.createInvitation).not.toHaveBeenCalled();
    });

    it('refuses to invite an existing member', async () => {
      const res = await call(invitationsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { email: `${ids.creator}@example.test`, role: 'viewer' },
      });
      expect(res.status).toBe(409);
      expect(gateway.createInvitation).not.toHaveBeenCalled();
    });

    it('answers 501 in core mode (Core owns the members)', async () => {
      setMembershipGateway(undefined);
      vi.stubEnv('STUDIO_MODE', 'core');
      const res = await call(invitationsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { email: 'later@example.test', role: 'viewer' },
      });
      expect(res.status).toBe(501);
      vi.unstubAllEnvs();
    });

    it('resends and revokes only this organisation’s invitations', async () => {
      const resend = await call(resendRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: invitationA },
      });
      expect(resend.status).toBe(200);
      expect(gateway.createInvitation).toHaveBeenCalledWith(expect.any(Headers), {
        organisationId: orgA,
        email: 'new@example.test',
        role: 'creator',
        resend: true,
      });
      const revoke = await call(invitationRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id: invitationA },
      });
      expect(revoke.status).toBe(200);
      expect(gateway.cancelInvitation).toHaveBeenCalledWith(expect.any(Headers), {
        invitationId: invitationA,
      });
      for (const res of [
        await call(resendRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: invitationB },
        }),
        await call(invitationRoute.DELETE, {
          method: 'DELETE',
          token: 'owner',
          params: { id: invitationB },
        }),
      ])
        expect(res.status).toBe(404);
    });
  });

  describe('audit', () => {
    it('owners and admins read their own organisation’s log only, newest first', async () => {
      const res = await call(auditRoute.GET, { token: 'admin' });
      expect(res.status).toBe(200);
      const rows = res.json.data as Array<{ action: string; actorName: string | null }>;
      expect(rows.map((r) => r.action)).toEqual([
        'member.role_changed',
        'org.renamed',
        'member.invited',
      ]);
      expect(rows[0]?.actorName).toBe('User admin');
      const other = await call(auditRoute.GET, { token: 'outsider' });
      expect((other.json.data as unknown[]).length).toBe(1);
    });

    it('paginates with a cursor and filters by action prefix', async () => {
      const first = await call(auditRoute.GET, {
        token: 'owner',
        path: '/api/studio/audit?limit=2',
      });
      expect((first.json.data as unknown[]).length).toBe(2);
      const next = await call(auditRoute.GET, {
        token: 'owner',
        path: `/api/studio/audit?limit=2&cursor=${String(first.json.nextCursor)}`,
      });
      expect((next.json.data as Array<{ action: string }>).map((r) => r.action)).toEqual([
        'member.invited',
      ]);
      expect(next.json.nextCursor).toBeNull();
      const filtered = await call(auditRoute.GET, {
        token: 'owner',
        path: '/api/studio/audit?action=member.',
      });
      expect((filtered.json.data as unknown[]).length).toBe(2);
      const bad = await call(auditRoute.GET, {
        token: 'owner',
        path: '/api/studio/audit?cursor=zz',
      });
      expect(bad.status).toBe(400);
    });

    it('creators cannot read the audit log', async () => {
      expect((await call(auditRoute.GET, { token: 'creator' })).status).toBe(403);
    });
  });
});
