import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as legalRoute from '../../src/app/api/studio/admin/legal-readiness/route';
import * as orgDetailRoute from '../../src/app/api/studio/admin/organisations/[id]/route';
import * as orgsRoute from '../../src/app/api/studio/admin/organisations/route';
import * as subscriptionsRoute from '../../src/app/api/studio/admin/subscriptions/route';
import * as banRoute from '../../src/app/api/studio/admin/users/[id]/ban/route';
import * as impersonateRoute from '../../src/app/api/studio/admin/users/[id]/impersonate/route';
import * as userRoute from '../../src/app/api/studio/admin/users/[id]/route';
import * as sessionsRoute from '../../src/app/api/studio/admin/users/[id]/sessions/route';
import * as twoFactorRoute from '../../src/app/api/studio/admin/users/[id]/two-factor/route';
import * as usersRoute from '../../src/app/api/studio/admin/users/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as orgRoute from '../../src/app/api/studio/org/route';
import { legalContentDir } from '../../src/lib/legal/documents';
import { legalReadiness } from '../../src/lib/legal/readiness';
import { setImpersonationStarter } from '../../src/lib/studio/admin/impersonation';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { BillingService } from '../../src/lib/studio/billing/contracts';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi } from '../helpers/api-harness';

// §5.11: DELETE /org re-authenticates through Better Auth; the password check is stubbed here
// (test/api/p18-e-org-members.test.ts covers a refused password).
const reauth = vi.hoisted(() => ({
  fn: vi.fn(async (_req: Pick<Request, 'headers'>, _password: string | undefined) => undefined),
}));
vi.mock('../../src/lib/auth/reauth', () => ({ reauthenticateRequest: reauth.fn }));

// Phase 18 Track E — admin Organisations / Users / Subscriptions tabs and impersonation:
// staff capability (granted only with 2FA by the identity provider) is required on every route,
// impersonation is off by default and read-only when on, staff cannot be impersonated or banned
// from the console, and every action is audited. Plus organisation deletion end to end.

const hasDb = Boolean(process.env.DATABASE_URL);

function staff(
  userId: string,
  capabilities: string[],
  platformRole: TenantContext['platformRole'],
): TenantContext {
  return {
    userId,
    organisationId: 'p18e-staff-org',
    organisation: { id: 'p18e-staff-org' },
    memberships: [{ organisationId: 'p18e-staff-org', role: 'owner' }],
    capabilities,
    platformRole,
  };
}

describe.skipIf(!hasDb)(
  'admin organisations, users and subscriptions API',
  { timeout: 60_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const run = randomUUID().slice(0, 8);
    const org = `p18e-adm-org-${run}`;
    const doomed = `p18e-adm-doomed-${run}`;
    const user = `p18e-adm-user-${run}`;
    const staffUser = `p18e-adm-staff-${run}`;
    const superId = `p18e-adm-super-${run}`;
    const tokens = {
      superadmin: staff(superId, ['studio:admin:*'], 'superadmin'),
      staff: staff(
        staffUser,
        ['studio:admin:kill-switch:read', 'studio:admin:moderation'],
        'staff',
      ),
      // A superadmin without 2FA: the identity provider grants no admin capability at all.
      noTwoFactor: staff(superId, [], 'superadmin'),
      owner: {
        userId: user,
        organisationId: org,
        organisation: { id: org },
        memberships: [{ organisationId: org, role: 'owner' }],
        capabilities: ['studio:project:read', 'studio:project:write', 'studio:org:delete'],
        role: 'owner',
      } satisfies TenantContext,
      impersonated: {
        userId: user,
        organisationId: org,
        organisation: { id: org },
        memberships: [{ organisationId: org, role: 'owner' }],
        capabilities: ['studio:project:read', 'studio:project:write'],
        impersonatorUserId: superId,
      } satisfies TenantContext,
      doomedOwner: {
        userId: user,
        organisationId: doomed,
        organisation: { id: doomed },
        memberships: [{ organisationId: doomed, role: 'owner' }],
        capabilities: ['studio:project:read', 'studio:org:delete'],
        role: 'owner',
      } satisfies TenantContext,
    };
    let api: ReturnType<typeof installApi>;

    beforeAll(async () => {
      await db.user.createMany({
        data: [
          { id: user, name: 'Ada Baker', email: `${user}@example.test`, emailVerified: true },
          { id: staffUser, name: 'Staff', email: `${staffUser}@example.test`, role: 'staff' },
          { id: superId, name: 'Super', email: `${superId}@example.test`, role: 'superadmin' },
        ],
      });
      await db.organization.create({ data: { id: org, name: `Crumb ${run}`, slug: org } });
      await db.organization.create({ data: { id: doomed, name: 'Doomed Bakes', slug: doomed } });
      await db.member.create({
        data: { id: `${org}-m`, organizationId: org, userId: user, role: 'owner' },
      });
      await db.session.create({
        data: {
          id: `${user}-s`,
          token: `${user}-token`,
          userId: user,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await db.orgEntitlement.create({
        data: { organisationId: org, tier: 'STANDARD', access: 'full', source: 'stripe' },
      });
      await db.subscription.create({
        data: {
          id: `sub_${run}`,
          organisationId: org,
          stripeCustomerId: `cus_${run}`,
          status: 'past_due',
          lookupKey: 'studio_standard_monthly',
          interval: 'month',
        },
      });
    });

    beforeEach(() => {
      api = installApi(db, tokens);
      api.deps.identity = { mode: 'standalone', resolve: vi.fn(), invalidate: vi.fn() };
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      setImpersonationStarter(undefined);
    });

    afterAll(async () => {
      setApiDeps(undefined);
      await db.subscription.deleteMany({ where: { organisationId: org } });
      await db.orgEntitlement.deleteMany({ where: { organisationId: org } });
      // The deletion test starts a real purge; remove its row so another suite's hard-delete job
      // (which runs past the grace period) never picks this organisation up.
      await db.organisationPurge.deleteMany({ where: { organisationId: doomed } });
      await db.organization.deleteMany({ where: { id: { in: [org, doomed] } } });
      await db.user.deleteMany({ where: { id: { in: [user, staffUser, superId] } } });
      await db.$disconnect();
    });

    it('every admin route refuses members and staff without the capability (e.g. no 2FA)', async () => {
      const routes = [
        () => call(orgsRoute.GET, { token: 'noTwoFactor' }),
        () => call(orgDetailRoute.GET, { token: 'owner', params: { id: org } }),
        () => call(usersRoute.GET, { token: 'staff' }),
        () => call(userRoute.GET, { token: 'noTwoFactor', params: { id: user } }),
        () => call(subscriptionsRoute.GET, { token: 'owner' }),
        () => call(legalRoute.GET, { token: 'owner' }),
        () =>
          call(banRoute.POST, {
            method: 'POST',
            token: 'staff',
            params: { id: user },
            body: { banned: true, reason: 'spam' },
          }),
        () =>
          call(impersonateRoute.POST, {
            method: 'POST',
            token: 'staff',
            params: { id: user },
            body: { reason: 'support ticket' },
          }),
      ];
      for (const route of routes) expect((await route()).status).toBe(403);
    });

    it('searches organisations with plan, status and members', async () => {
      const res = await call(orgsRoute.GET, {
        token: 'superadmin',
        path: `/api/studio/admin/organisations?q=crumb ${run}`,
      });
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual([
        expect.objectContaining({
          id: org,
          members: 1,
          tier: 'STANDARD',
          access: 'full',
          subscriptionStatus: 'past_due',
          costThisMonthPence: 0,
        }),
      ]);
    });

    it('20.27: the list resolves overrides and shows the trial, a page at a time', async () => {
      const trialOrg = `p18e-adm-trial-${run}`;
      const lapsedOrg = `p18e-adm-lapsed-${run}`;
      const derived = { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' };
      const trial = {
        startedAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-10-15T00:00:00.000Z',
        shortVideos: 5,
        longVideos: 1,
        dailyCostCapPence: 1_000,
        totalCostCapPence: 1_500,
      };
      const admin = { reason: 'ops', setByUserId: superId, setAt: '2026-10-01T00:00:00.000Z' };
      await db.organization.createMany({
        data: [
          { id: trialOrg, name: `Trialbake ${run} one`, slug: trialOrg },
          { id: lapsedOrg, name: `Trialbake ${run} two`, slug: lapsedOrg },
        ],
      });
      await db.orgEntitlement.createMany({
        data: [
          {
            organisationId: trialOrg,
            tier: 'PLUS',
            access: 'full',
            source: 'admin',
            overrides: { derived, trial, admin: { ...admin, tier: 'PLUS', expiresAt: null } },
          },
          {
            // The stored columns still say PLUS, but the override expired: the list says STANDARD.
            organisationId: lapsedOrg,
            tier: 'PLUS',
            access: 'full',
            source: 'admin',
            overrides: {
              derived,
              trial,
              admin: { ...admin, tier: 'PLUS', expiresAt: '2026-01-01T00:00:00.000Z' },
            },
          },
        ],
      });
      try {
        const res = await call(orgsRoute.GET, {
          token: 'superadmin',
          path: `/api/studio/admin/organisations?q=trialbake ${run}`,
        });
        expect(res.json).toMatchObject({ total: 2, offset: 0, pageSize: 50 });
        const rows = new Map((res.json.data as Array<{ id: string }>).map((r) => [r.id, r]));
        expect(rows.get(trialOrg)).toMatchObject({
          tier: 'PLUS',
          source: 'admin',
          trial: { state: 'overridden', endsAt: trial.endsAt },
        });
        expect(rows.get(lapsedOrg)).toMatchObject({
          tier: 'STANDARD',
          source: 'trial',
          trial: { state: 'running', endsAt: trial.endsAt },
        });
        const page2 = await call(orgsRoute.GET, {
          token: 'superadmin',
          path: `/api/studio/admin/organisations?q=trialbake ${run}&offset=1`,
        });
        expect(page2.json).toMatchObject({ total: 2, offset: 1 });
        expect(page2.json.data).toHaveLength(1);
        const detail = await call(orgDetailRoute.GET, {
          token: 'superadmin',
          params: { id: trialOrg },
        });
        expect(detail.json).toMatchObject({
          entitlement: { tier: 'PLUS', source: 'admin', trial: { state: 'overridden' } },
        });
      } finally {
        await db.orgEntitlement.deleteMany({
          where: { organisationId: { in: [trialOrg, lapsedOrg] } },
        });
        await db.organization.deleteMany({ where: { id: { in: [trialOrg, lapsedOrg] } } });
      }
    });

    it('shows one organisation with members and subscription; unknown id is 404', async () => {
      const res = await call(orgDetailRoute.GET, { token: 'superadmin', params: { id: org } });
      expect(res.json).toMatchObject({
        organisation: { id: org },
        members: [{ userId: user, role: 'owner', email: `${user}@example.test` }],
        entitlement: { tier: 'STANDARD', source: 'stripe' },
        subscriptions: [{ id: `sub_${run}`, status: 'past_due' }],
      });
      const missing = await call(orgDetailRoute.GET, {
        token: 'superadmin',
        params: { id: 'nope' },
      });
      expect(missing.status).toBe(404);
    });

    it('searches users by email and shows their memberships', async () => {
      const res = await call(usersRoute.GET, {
        token: 'superadmin',
        path: `/api/studio/admin/users?q=${user.toUpperCase()}`,
      });
      expect(res.json.data).toEqual([
        expect.objectContaining({ id: user, sessions: 1, organisations: 1, banned: false }),
      ]);
      const detail = await call(userRoute.GET, { token: 'superadmin', params: { id: user } });
      expect(detail.json).toMatchObject({
        memberships: [{ organisationId: org, role: 'owner' }],
        impersonation: false,
      });
    });

    it('lists subscriptions read-only with status counts and filter', async () => {
      const res = await call(subscriptionsRoute.GET, {
        token: 'superadmin',
        path: '/api/studio/admin/subscriptions?status=past_due',
      });
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `sub_${run}`, organisationName: `Crumb ${run}` }),
        ]),
      );
      expect((res.json.byStatus as Record<string, number>).past_due).toBeGreaterThanOrEqual(1);
      const bad = await call(subscriptionsRoute.GET, {
        token: 'superadmin',
        path: '/api/studio/admin/subscriptions?status=weird',
      });
      expect(bad.status).toBe(400);
    });

    it('bans (revoking sessions), unbans, and audits with the reason', async () => {
      const ban = await call(banRoute.POST, {
        method: 'POST',
        token: 'superadmin',
        params: { id: user },
        body: { banned: true, reason: 'chargeback fraud' },
      });
      expect(ban.json).toMatchObject({ banned: true, sessionsRevoked: 1 });
      expect(await db.user.findUnique({ where: { id: user } })).toMatchObject({ banned: true });
      expect(api.deps.identity?.invalidate).toHaveBeenCalledWith(user);
      expect(api.audits.at(-1)).toMatchObject({
        action: 'staff.user_banned',
        metadata: expect.objectContaining({ reason: 'chargeback fraud' }),
      });
      const unban = await call(banRoute.POST, {
        method: 'POST',
        token: 'superadmin',
        params: { id: user },
        body: { banned: false, reason: 'appeal upheld' },
      });
      expect(unban.json).toMatchObject({ banned: false });
      const noReason = await call(banRoute.POST, {
        method: 'POST',
        token: 'superadmin',
        params: { id: user },
        body: { banned: true },
      });
      expect(noReason.status).toBe(400);
    });

    it('never bans or resets 2FA for staff from the console', async () => {
      const ban = await call(banRoute.POST, {
        method: 'POST',
        token: 'superadmin',
        params: { id: staffUser },
        body: { banned: true, reason: 'test' },
      });
      expect(ban.status).toBe(403);
      const reset = await call(twoFactorRoute.DELETE, {
        method: 'DELETE',
        token: 'superadmin',
        params: { id: staffUser },
        body: { reason: 'lost phone' },
      });
      expect(reset.status).toBe(403);
    });

    it('revokes sessions and resets 2FA, audited', async () => {
      await db.twoFactor.create({
        data: { id: `${user}-2fa`, userId: user, secret: 'enc', backupCodes: 'enc' },
      });
      await db.user.update({ where: { id: user }, data: { twoFactorEnabled: true } });
      const reset = await call(twoFactorRoute.DELETE, {
        method: 'DELETE',
        token: 'superadmin',
        params: { id: user },
        body: { reason: 'lost phone, id checked' },
      });
      expect(reset.status).toBe(200);
      expect(await db.twoFactor.count({ where: { userId: user } })).toBe(0);
      expect(api.audits.at(-1)).toMatchObject({ action: 'auth.2fa_disabled' });
      const revoke = await call(sessionsRoute.DELETE, {
        method: 'DELETE',
        token: 'superadmin',
        params: { id: user },
        body: { reason: 'takeover suspected' },
      });
      expect(revoke.json).toMatchObject({ revoked: 0 });
      expect(api.audits.at(-1)).toMatchObject({ action: 'auth.session_revoked' });
    });

    describe('impersonation', () => {
      it('is off by default', async () => {
        const res = await call(impersonateRoute.POST, {
          method: 'POST',
          token: 'superadmin',
          params: { id: user },
          body: { reason: 'support ticket 42' },
        });
        expect(res.status).toBe(403);
        expect(res.json.details).toEqual({ reason: 'impersonation_disabled' });
      });

      it('when on: reason required, never staff, audited, then hands off to Better Auth', async () => {
        vi.stubEnv('STUDIO_IMPERSONATION_ENABLED', 'true');
        const noReason = await call(impersonateRoute.POST, {
          method: 'POST',
          token: 'superadmin',
          params: { id: user },
          body: {},
        });
        expect(noReason.status).toBe(400);
        const onStaff = await call(impersonateRoute.POST, {
          method: 'POST',
          token: 'superadmin',
          params: { id: staffUser },
          body: { reason: 'support ticket 42' },
        });
        expect(onStaff.status).toBe(403);
        const pending = await call(impersonateRoute.POST, {
          method: 'POST',
          token: 'superadmin',
          params: { id: user },
          body: { reason: 'support ticket 42' },
        });
        expect(pending.status).toBe(501);
        const start = vi.fn(async () => ({ redirectTo: '/projects' }));
        setImpersonationStarter({ start });
        const res = await call(impersonateRoute.POST, {
          method: 'POST',
          token: 'superadmin',
          params: { id: user },
          body: { reason: 'support ticket 42' },
        });
        expect(res.json).toMatchObject({ redirectTo: '/projects', readOnly: true });
        expect(start).toHaveBeenCalledWith(expect.any(Headers), { userId: user });
        expect(api.audits.at(-1)).toMatchObject({
          action: 'staff.impersonation_started',
          actorUserId: superId,
          metadata: expect.objectContaining({ reason: 'support ticket 42' }),
        });
      });

      it('an impersonated session is read-only unless writes are switched on', async () => {
        const read = await call(projectsRoute.GET, { token: 'impersonated' });
        expect(read.status).toBe(200);
        const write = await call(projectsRoute.POST, {
          method: 'POST',
          token: 'impersonated',
          body: { name: 'x' },
        });
        expect(write.status).toBe(403);
        expect(write.json.details).toEqual({ reason: 'impersonation_read_only' });
        vi.stubEnv('STUDIO_IMPERSONATION_WRITE', 'true');
        const allowed = await call(projectsRoute.POST, {
          method: 'POST',
          token: 'impersonated',
          body: { name: 'x' },
        });
        expect(allowed.status).not.toBe(403);
      });
    });

    it('legal readiness lists the placeholders for staff', async () => {
      // The shipped drafts are filled in over time (content/legal/FILL-IN.md): compare with them.
      const expected = await legalReadiness(legalContentDir({}));
      const res = await call(legalRoute.GET, { token: 'staff' });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        readiness: { ready: expected.ready, launchBlockers: expected.launchBlockers },
        signups: { open: true },
      });
    });

    it('deleting an organisation cancels billing, soft-deletes it and starts the purge', async () => {
      const cancelForDeletion = vi.fn(async () => undefined);
      api.deps.billing = { cancelForDeletion } as unknown as BillingService;
      const res = await call(orgRoute.DELETE, {
        method: 'DELETE',
        token: 'doomedOwner',
        body: { confirmName: 'Doomed Bakes', password: 'owner-password' },
      });
      expect(res.status).toBe(200);
      expect(reauth.fn).toHaveBeenCalledWith(expect.anything(), 'owner-password');
      expect(res.json).toMatchObject({ deleted: true, graceUntil: expect.any(String) });
      expect(cancelForDeletion).toHaveBeenCalledWith(doomed);
      const row = await db.organization.findUnique({ where: { id: doomed } });
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(api.audits.at(-1)).toMatchObject({ action: 'org.deleted', organisationId: doomed });
    });
  },
);
