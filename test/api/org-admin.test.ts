import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as capsReportRoute from '../../src/app/api/studio/admin/cost/caps/route';
import * as costCapsRoute from '../../src/app/api/studio/admin/organisations/[id]/cost-caps/route';
import * as policyRoute from '../../src/app/api/studio/admin/organisations/[id]/policy/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.18 (GET|PUT /admin/organisations/:id/policy) and 13.19 (GET|PUT …/cost-caps):
// staff only, validation, audit with before/after, the caps report's org_override source, and
// the organisation's default review policy applied to new projects.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('organisation policy and cost cap admin API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-orgadm-staff-${randomUUID()}`;
  const org = `api-orgadm-org-${randomUUID()}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:moderation', 'studio:admin:providers'], 'staff-1'),
    staffNoProviders: tenant(staffOrg, ['studio:admin:moderation']),
    outsider: tenant(org, ['studio:admin:moderation', 'studio:admin:providers']),
    owner: tenant(org),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    vi.stubEnv('STUDIO_AUTO_APPROVE_TRUST_THRESHOLD', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.orgPolicy.deleteMany({ where: { organisationId: org } });
    await db.orgCostCap.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  describe('policy', () => {
    it('is staff only', async () => {
      const res = await call(policyRoute.GET, { token: 'outsider', params: { id: org } });
      expect(res.status).toBe(403);
      const put = await call(policyRoute.PUT, {
        method: 'PUT',
        token: 'owner',
        params: { id: org },
        body: { autoApproveAllowed: false },
      });
      expect(put.status).toBe(403);
    });

    it('GET returns platform defaults for an organisation without a policy', async () => {
      const res = await call(policyRoute.GET, { token: 'staff', params: { id: org } });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        organisationId: org,
        policy: {
          defaultReviewPolicy: 'REQUIRE_APPROVAL',
          autoApproveTrustThreshold: 10,
          autoApproveAllowed: true,
        },
      });
    });

    it('PUT updates part of the policy, audits before/after and applies to new projects', async () => {
      const res = await call(policyRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { defaultReviewPolicy: 'REQUIRE_APPROVAL_FROM_ROLE', autoApproveTrustThreshold: 3 },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        policy: {
          defaultReviewPolicy: 'REQUIRE_APPROVAL_FROM_ROLE',
          autoApproveTrustThreshold: 3,
          autoApproveAllowed: true,
        },
        source: { defaultReviewPolicy: 'organisation', autoApproveTrustThreshold: 'organisation' },
      });
      expect(api.audits.find((a) => a.action === 'studio.admin.org_policy.update')).toMatchObject({
        actorUserId: 'staff-1',
        resource: { type: 'organisation', id: org },
        metadata: expect.objectContaining({
          before: expect.objectContaining({ autoApproveTrustThreshold: 10 }),
          after: expect.objectContaining({ autoApproveTrustThreshold: 3 }),
        }),
      });

      const body = {
        name: 'Uses the organisation default',
        businessId: 'biz-1',
        brief: { rawInput: 'Launch our sourdough subscription' },
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
      };
      const created = await call(projectsRoute.POST, { method: 'POST', token: 'owner', body });
      expect(created.status).toBe(201);
      expect((created.json.project as { reviewPolicy: string }).reviewPolicy).toBe(
        'REQUIRE_APPROVAL_FROM_ROLE',
      );
      const explicit = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { ...body, reviewPolicy: 'AUTO_APPROVE' },
      });
      expect((explicit.json.project as { reviewPolicy: string }).reviewPolicy).toBe('AUTO_APPROVE');

      // null resets a value.
      const reset = await call(policyRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { autoApproveTrustThreshold: null },
      });
      expect(reset.json).toMatchObject({ policy: { autoApproveTrustThreshold: 10 } });
    });

    it('validates the body', async () => {
      for (const body of [{}, { autoApproveTrustThreshold: 0 }, { reviewPolicy: 'AUTO_APPROVE' }]) {
        const res = await call(policyRoute.PUT, {
          method: 'PUT',
          token: 'staff',
          params: { id: org },
          body,
        });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('cost caps', () => {
    it('needs studio:admin:providers and a staff organisation', async () => {
      expect(
        (await call(costCapsRoute.GET, { token: 'outsider', params: { id: org } })).status,
      ).toBe(403);
      expect(
        (await call(costCapsRoute.GET, { token: 'staffNoProviders', params: { id: org } })).status,
      ).toBe(403);
    });

    it('GET without an override shows the plan tier caps', async () => {
      const res = await call(costCapsRoute.GET, { token: 'staff', params: { id: org } });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        organisationId: org,
        override: null,
        caps: {
          daily: { pence: null, source: 'plan_tier', byTier: { STANDARD: { pence: 3_000 } } },
          monthly: { pence: null, source: 'plan_tier' },
        },
      });
    });

    it('PUT sets an override with a reason, audits it, and the caps report lists it', async () => {
      const res = await call(costCapsRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: {
          dailyPence: 20_000,
          monthlyPence: 100_000,
          reason: 'Pilot, agreed with Commercial',
        },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        caps: {
          daily: { pence: 20_000, source: 'org_override' },
          monthly: { pence: 100_000, source: 'org_override' },
        },
        override: { reason: 'Pilot, agreed with Commercial', updatedByUserId: 'staff-1' },
      });
      expect(api.audits.find((a) => a.action === 'studio.admin.cost_caps.override')).toMatchObject({
        metadata: {
          before: null,
          after: { dailyPence: 20_000, monthlyPence: 100_000 },
          reason: 'Pilot, agreed with Commercial',
        },
      });

      const report = await call(capsReportRoute.GET, { token: 'staff' });
      expect(report.status).toBe(200);
      expect(report.json.orgOverrides).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organisationId: org,
            dailyPence: 20_000,
            source: 'org_override',
          }),
        ]),
      );

      const cleared = await call(costCapsRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { monthlyPence: null, reason: 'Back to plan for the month' },
      });
      expect(cleared.json).toMatchObject({
        caps: { daily: { source: 'org_override' }, monthly: { source: 'plan_tier' } },
      });
    });

    it('validates: a reason is required and caps must be positive pence', async () => {
      for (const body of [
        { dailyPence: 1000 },
        { dailyPence: -1, reason: 'negative' },
        { reason: 'nothing to change' },
        { dailyPence: 1000, reason: 'x', extra: true },
      ]) {
        const res = await call(costCapsRoute.PUT, {
          method: 'PUT',
          token: 'staff',
          params: { id: org },
          body,
        });
        expect(res.status).toBe(400);
      }
    });
  });
});
