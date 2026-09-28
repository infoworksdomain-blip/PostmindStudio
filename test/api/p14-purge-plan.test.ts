import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as purgePlanRoute from '../../src/app/api/studio/admin/organisations/[id]/purge-plan/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 14.1 — GET /api/studio/admin/organisations/:id/purge-plan: staff only, validation,
// read-only dry run (the full purge → hard delete journey is test/golden/p14-org-purge.test.ts).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('purge plan admin API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-pplan-staff-${randomUUID()}`;
  const org = `api-pplan-org-${randomUUID()}`;

  beforeEach(() => {
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    vi.stubEnv('S3_BUCKET_ASSETS', 'assets');
    installApi(db, {
      staff: tenant(staffOrg, ['studio:admin:moderation'], 'staff-1'),
      staffNoCap: tenant(staffOrg, ['studio:admin:providers']),
      outsider: tenant(org, ['studio:admin:moderation']),
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('is for PostMind staff with studio:admin:moderation only', async () => {
    expect(
      (await call(purgePlanRoute.GET, { token: 'outsider', params: { id: org } })).status,
    ).toBe(403);
    expect(
      (await call(purgePlanRoute.GET, { token: 'staffNoCap', params: { id: org } })).status,
    ).toBe(403);
  });

  it('refuses an id that cannot be a storage prefix', async () => {
    const res = await call(purgePlanRoute.GET, { token: 'staff', params: { id: 'a/../b' } });
    expect(res.status).toBe(400);
  });

  it('sizes an organisation that has not been purged, without deleting anything', async () => {
    await db.notification.create({
      data: { organisationId: org, kind: 'cost_alert', title: 't', body: 'b' },
    });
    const res = await call(purgePlanRoute.GET, { token: 'staff', params: { id: org } });
    expect(res.status).toBe(200);
    expect(res.json.plan).toMatchObject({
      organisationId: org,
      purge: null,
      storage: [{ bucket: 'assets', prefix: `orgs/${org}/`, objects: 0, truncated: false }],
      totals: { rows: 1, objects: 0, bytes: 0 },
    });
    expect(await db.notification.count({ where: { organisationId: org } })).toBe(1);
  });
});
