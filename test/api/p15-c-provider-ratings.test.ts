import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ratingsRoute from '../../src/app/api/studio/businesses/[id]/provider-ratings/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';
import { seedProviderRatings } from '../helpers/provider-ratings-seed';

// P7: GET /api/studio/businesses/:id/provider-ratings — auth, capability, validation, tenant
// isolation.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('GET /businesses/:id/provider-ratings', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p7-${randomUUID()}`;
  const otherOrg = `api-p7-other-${randomUUID()}`;
  let seeded: Awaited<ReturnType<typeof seedProviderRatings>>;

  beforeAll(async () => {
    installApi(db, {
      reader: tenant(org, ['studio:project:read']),
      noread: tenant(org, ['studio:publication:write']),
      other: tenant(otherOrg),
      forbidden: 'forbidden',
    });
    seeded = await seedProviderRatings(db, {
      organisationId: org,
      businessId: 'biz-p7',
      now: Date.now(),
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await seeded?.cleanup();
    await db.$disconnect();
  });

  it('returns the business ratings with their components', async () => {
    const res = await call(ratingsRoute.GET, { token: 'reader', params: { id: 'biz-p7' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      scores: [
        {
          providerId: 'runway',
          score: 1,
          components: { approvalRate: 1, regenerationRate: 0, retention: 0.7 },
          sampleShots: 5,
          routed: true,
        },
        {
          providerId: 'luma',
          score: 0.171,
          components: { approvalRate: 0, regenerationRate: 0.6, retention: null },
          sampleShots: 5,
          routed: true,
        },
      ],
    });
  });

  it('never shows another organisation the ratings', async () => {
    const res = await call(ratingsRoute.GET, { token: 'other', params: { id: 'biz-p7' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, scores: [] });
  });

  it('requires auth and the project-read capability, and validates the id', async () => {
    expect((await call(ratingsRoute.GET, { params: { id: 'biz-p7' } })).status).toBe(401);
    expect(
      (await call(ratingsRoute.GET, { token: 'forbidden', params: { id: 'biz-p7' } })).status,
    ).toBe(403);
    expect(
      (await call(ratingsRoute.GET, { token: 'noread', params: { id: 'biz-p7' } })).status,
    ).toBe(403);
    expect(
      (await call(ratingsRoute.GET, { token: 'reader', params: { id: 'x'.repeat(200) } })).status,
    ).toBe(400);
  });
});
