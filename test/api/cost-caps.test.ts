import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as capsRoute from '../../src/app/api/studio/admin/cost/caps/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { utcDay } from '../../src/lib/studio/providers/job-repository';
import { call, installApi, tenant } from '../helpers/api-harness';

// GET /api/studio/admin/cost/caps (spec 12.5 / 16.4): today's spend against each configured cap,
// projects near their budget and recent cost alerts; platform staff only.

const hasDb = Boolean(process.env.DATABASE_URL);

type Caps = {
  day: string;
  caps: {
    globalDaily: { capPence: number | null; spentPence: number; percent: number | null };
    orgDailyByTier: Record<string, number | null>;
    orgProviderDaily: number | null;
    projectPausePercent: number;
  };
  organisations: Array<{
    organisationId: string;
    spentPence: number;
    providers: Array<{ provider: string; spentPence: number; percentOfCap: number | null }>;
  }>;
  projects: Array<{ id: string; percent: number; paused: boolean }>;
  recentAlerts: Array<{ scope: string; scopeId: string; threshold: number }>;
};

describe.skipIf(!hasDb)('admin cost caps API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-caps-staff-${randomUUID()}`;
  const org = `api-caps-org-${randomUUID()}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:providers']),
    outsider: tenant(org, ['studio:admin:providers']),
    staffNoCaps: tenant(staffOrg, ['studio:project:read']),
  };
  let projectId = '';

  beforeEach(async () => {
    installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    vi.stubEnv('STUDIO_GLOBAL_DAILY_CAP_PENCE', '100000000');
    vi.stubEnv('STUDIO_ORG_DAILY_CAP_PENCE_BASIC', '500');
    vi.stubEnv('STUDIO_ORG_DAILY_CAP_PENCE_PLUS', '');
    vi.stubEnv('STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE', '1000');
    const day = utcDay(new Date());
    await db.providerUsage.createMany({
      data: [
        { organisationId: org, provider: 'runway', day, jobCount: 3, costPence: 900 },
        { organisationId: org, provider: 'elevenlabs', day, jobCount: 5, costPence: 50 },
      ],
      skipDuplicates: true,
    });
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'u',
        name: 'Near budget',
        state: 'FAILED',
        sourceType: 'BRIEF',
        targetFormats: [],
        costBudgetPence: 100,
        costActualPence: 95,
        errorReason: 'cost_cap_paused: project reached 90% of its budget',
      },
    });
    projectId = project.id;
    await db.costAlert.createMany({
      data: [
        {
          scope: 'PROJECT',
          scopeId: project.id,
          organisationId: org,
          period: 'budget:100',
          threshold: 90,
          capPence: 100,
          spentPence: 95,
        },
      ],
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.costAlert.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  it('reports spend against every configured cap and the recent alerts', async () => {
    const res = await call(capsRoute.GET, { token: 'staff' });
    expect(res.status).toBe(200);
    const body = res.json as unknown as Caps;
    expect(body.day).toBe(new Date().toISOString().slice(0, 10));
    expect(body.caps.orgDailyByTier).toEqual({
      BASIC: 500,
      STANDARD: null,
      PLUS: null,
      ENTERPRISE: null,
    });
    expect(body.caps.orgProviderDaily).toBe(1000);
    expect(body.caps.projectPausePercent).toBe(90);
    expect(body.caps.globalDaily.capPence).toBe(100_000_000);
    expect(body.caps.globalDaily.spentPence).toBeGreaterThanOrEqual(950);

    const mine = body.organisations.find((o) => o.organisationId === org);
    expect(mine).toEqual({
      organisationId: org,
      spentPence: 950,
      providers: [
        { provider: 'runway', spentPence: 900, percentOfCap: 90 },
        { provider: 'elevenlabs', spentPence: 50, percentOfCap: 5 },
      ],
    });
    expect(body.projects.find((p) => p.id === projectId)).toMatchObject({
      percent: 95,
      paused: true,
    });
    expect(body.recentAlerts).toContainEqual(
      expect.objectContaining({ scope: 'PROJECT', scopeId: projectId, threshold: 90 }),
    );
  });

  it('is for platform staff with studio:admin:providers only', async () => {
    expect((await call(capsRoute.GET, { token: 'outsider' })).status).toBe(403);
    expect((await call(capsRoute.GET, { token: 'staffNoCaps' })).status).toBe(403);
    expect((await call(capsRoute.GET)).status).toBe(401);
  });

  it('refuses to serve with a malformed cap setting (configuration error, no detail leaked)', async () => {
    vi.stubEnv('STUDIO_GLOBAL_DAILY_CAP_PENCE', 'lots');
    const res = await call(capsRoute.GET, { token: 'staff' });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ ok: false, error: 'internal_error' });
  });
});
