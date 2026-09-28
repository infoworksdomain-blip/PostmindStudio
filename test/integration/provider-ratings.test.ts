import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeProviderRatings,
  computeProviderScores,
  createProviderRatings,
} from '../../src/lib/studio/services/provider-ratings';
import { orderByScore } from '../../src/lib/studio/providers/router';
import { seedProviderRatings } from '../helpers/provider-ratings-seed';

// P7 against Postgres: ratings read from video_assets / approval_tasks / video_analytics.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('provider ratings (DB)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `ratings-${randomUUID()}`;
  const now = Date.now();
  let seeded: Awaited<ReturnType<typeof seedProviderRatings>>;

  beforeAll(async () => {
    seeded = await seedProviderRatings(db, { organisationId: org, businessId: 'biz-r', now });
  });

  afterAll(async () => {
    await seeded?.cleanup();
    await db.$disconnect();
  });

  it('rates Runway above Luma from approvals, regenerations and retention', async () => {
    const ratings = await computeProviderRatings(db, {
      organisationId: org,
      businessId: 'biz-r',
      now,
    });
    expect(ratings).toEqual([
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
    ]);
    const scores = await computeProviderScores(db, {
      organisationId: org,
      businessId: 'biz-r',
      now,
    });
    expect(orderByScore(['luma', 'runway', 'kling'], scores)).toEqual(['runway', 'kling', 'luma']);
  });

  it('is scoped to the organisation, the business and the window', async () => {
    const input = { businessId: 'biz-r', now };
    expect(await computeProviderScores(db, { ...input, organisationId: 'other-org' })).toEqual({});
    expect(
      await computeProviderScores(db, { organisationId: org, businessId: 'biz-x', now }),
    ).toEqual({});
    expect(
      await computeProviderScores(db, { organisationId: org, ...input, windowDays: 1 }),
    ).toEqual({});
  });

  it('scoresFor resolves the project business', async () => {
    const ratings = createProviderRatings({ db, now: () => now });
    const [projectId] = seeded.projectIds;
    expect(await ratings.scoresFor({ organisationId: org, projectId })).toEqual({
      runway: 1,
      luma: 0.171,
    });
    expect(await ratings.scoresFor({ organisationId: 'other-org', projectId })).toEqual({});
  });
});
