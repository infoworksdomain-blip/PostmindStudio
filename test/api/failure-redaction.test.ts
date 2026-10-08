import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// QA 3: raw provider / platform text never reaches a customer's browser, whichever route sends the
// reason; platform staff still read it (src/lib/studio/api/failure-presenter.ts).

const hasDb = Boolean(process.env.DATABASE_URL);
const RAW_PUB = 'youtube_short/unavailable: connect ECONNREFUSED 10.0.0.1:443';
const RAW_PROJECT = 'runway/provider_unavailable: upstream said host 10.1.1.1 token=abc123';

describe.skipIf(!hasDb)('failure reasons in API responses', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-redact-${randomUUID()}`;
  const tokens = {
    customer: tenant(org),
    staff: { ...tenant(org), platformRole: 'staff' as const },
  };
  let projectId = '';

  beforeAll(async () => {
    installApi(db, tokens);
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'u',
        name: 'Failing',
        state: 'FAILED',
        sourceType: 'BRIEF',
        targetFormats: [],
        errorReason: RAW_PROJECT,
      },
    });
    projectId = project.id;
    const render = await db.videoRender.create({
      data: {
        projectId,
        scriptId: 's',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 10,
        fps: 30,
        bitrateKbps: 1000,
        s3Bucket: 'b',
        s3Key: 'k',
        qualityCheckState: 'PASSED',
      },
    });
    await db.videoPublication.create({
      data: {
        organisationId: org,
        projectId,
        renderId: render.id,
        platform: 'youtube_short',
        platformAccountId: 'acct',
        state: 'FAILED',
        errorReason: RAW_PUB,
        errorCode: 'unavailable',
      },
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoPublication.deleteMany({ where: { projectId } });
    await db.videoRender.deleteMany({ where: { projectId } });
    await db.videoProject.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
  });

  const text = (json: unknown) => JSON.stringify(json);

  it('publications list: a customer gets the code, staff get the stored text', async () => {
    const customer = await call(publicationsRoute.GET, { token: 'customer' });
    expect(customer.status).toBe(200);
    expect(text(customer.json)).toContain('youtube_short/unavailable:');
    expect(text(customer.json)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
    // 25.9: a hand-made post belongs to no month plan or automation.
    const rows = (customer.json as { data: Array<{ campaign: unknown }> }).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.campaign === null)).toBe(true);

    const staff = await call(publicationsRoute.GET, { token: 'staff' });
    expect(text(staff.json)).toContain(RAW_PUB);
  });

  it('project detail: the project and its publications are redacted for a customer', async () => {
    const customer = await call(projectRoute.GET, { token: 'customer', params: { id: projectId } });
    expect(customer.status).toBe(200);
    expect(text(customer.json)).toContain('runway/provider_unavailable:');
    expect(text(customer.json)).not.toMatch(/10\.1\.1\.1|token=abc123|upstream said|ECONNREFUSED/);

    const staff = await call(projectRoute.GET, { token: 'staff', params: { id: projectId } });
    expect(text(staff.json)).toContain(RAW_PROJECT);
    expect(text(staff.json)).toContain(RAW_PUB);
  });
});
