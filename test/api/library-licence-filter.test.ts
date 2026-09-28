import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as blueprintRoute from '../../src/app/api/studio/library/blueprint/[libraryVideoId]/route';
import * as recommendedRoute from '../../src/app/api/studio/library/recommended/route';
import * as similarRoute from '../../src/app/api/studio/library/videos/[id]/similar/route';
import * as videoRoute from '../../src/app/api/studio/library/videos/[id]/route';
import * as videosRoute from '../../src/app/api/studio/library/videos/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { vectorLiteral } from '../../src/lib/studio/images/ingest';
import { profileDocument } from '../../src/lib/studio/library/similarity';
import { vectorSql } from '../../src/lib/studio/vector-sql';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness, PROFILE_JSON } from '../helpers/pipeline-harness';
import { fakeEmbedding } from '../helpers/png';

// BACKLOG 15.D7 / Addendum A11.1 — "Every video_library row MUST have a video_library_licenses
// row with scenario populated. Rows without a licence status are unusable — the API rejects them
// from search results." Free-text search already joined the licence table (13.8); browse,
// similar, recommended, detail and blueprint must exclude licence-less rows too.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!hasDb)('library licence filter (A11.1)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-liclib-${randomUUID()}`;
  const biz = `biz-${randomUUID()}`;
  const tokens = { reader: tenant(org, ['studio:project:read']) };
  const ids: Record<string, string> = {};
  const profileText = profileDocument({
    industry: PROFILE_JSON.industry,
    subNiche: PROFILE_JSON.subNiche,
    products: PROFILE_JSON.products,
    services: PROFILE_JSON.services,
    audienceKeywords: PROFILE_JSON.audienceKeywords,
    toneIndicators: PROFILE_JSON.toneIndicators,
    imageThemes: PROFILE_JSON.imageThemes,
    brandVoiceSummary: null,
  });

  async function item(key: string, category: string, text: string, licensed: boolean) {
    const row = await db.videoLibraryItem.create({
      data: {
        title: `${key} ${RUN}`,
        categoryId: category,
        tags: ['licence-test'],
        s3Bucket: 'library',
        s3Key: `library/${RUN}-${key}.mp4`,
        thumbnailS3Key: `library/${RUN}-${key}-thumb.jpg`,
        durationSec: 15,
        aspectRatio: '9:16',
      },
    });
    if (licensed)
      await db.videoLibraryLicense.create({
        data: { libraryItemId: row.id, scenario: 'OWNED', allowedModes: ['TEMPLATE', 'INSPIRE'] },
      });
    await db.videoLibraryAnalysis.create({
      data: {
        libraryItemId: row.id,
        shotCount: 1,
        shots: [{ startSec: 0, endSec: 15, type: 'b-roll' }],
        transcript: {},
        overlayTimeline: [],
        musicEnvelope: {},
        hookPattern: 'question',
        structurePattern: 'hook-body-cta',
        paceTag: 'fast',
        moodTag: 'warm',
      },
    });
    const v = await vectorSql(db);
    await db.$executeRaw`
      INSERT INTO studio.video_library_embeddings (id, "libraryItemId", embedding, "embeddingModel")
      VALUES (${randomUUID()}, ${row.id}, ${vectorLiteral(fakeEmbedding(text))}${v.cast}, 'test')`;
    ids[key] = row.id;
  }

  beforeAll(async () => {
    const h = createHarness(db);
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
    const cat = await db.videoLibraryCategory.create({
      data: { slug: `lic${RUN}/food`, name: 'Food', depth: 0 },
    });
    // Both share the business profile's text, so both are nearest neighbours of each other and
    // of the profile: only the licence row separates them.
    await item('licensed', cat.id, profileText, true);
    await item('licensed2', cat.id, profileText, true);
    await item('unlicensed', cat.id, profileText, false);
    await db.businessProfile.create({
      data: {
        organisationId: org,
        businessId: biz,
        industry: PROFILE_JSON.industry,
        subNiche: PROFILE_JSON.subNiche,
        products: PROFILE_JSON.products,
        services: PROFILE_JSON.services,
        audienceKeywords: PROFILE_JSON.audienceKeywords,
        toneIndicators: PROFILE_JSON.toneIndicators,
        regions: PROFILE_JSON.regions,
        imageThemes: PROFILE_JSON.imageThemes,
        imageSearchQueries: PROFILE_JSON.searchQueries,
        restrictedTopics: [],
        classifierModel: 'test',
      },
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const itemIds = Object.values(ids);
    await db.$executeRaw`DELETE FROM studio.video_library_embeddings WHERE "libraryItemId" = ANY(${itemIds})`;
    await db.videoLibraryAnalysis.deleteMany({ where: { libraryItemId: { in: itemIds } } });
    await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: itemIds } } });
    await db.videoLibraryItem.deleteMany({ where: { id: { in: itemIds } } });
    await db.videoLibraryCategory.deleteMany({ where: { slug: { startsWith: `lic${RUN}/` } } });
    await db.businessProfile.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const listIds = (json: Record<string, unknown>) =>
    (json.data as Array<{ id: string }>).map((d) => d.id);

  it('GET /library/videos never lists a row without a licence', async () => {
    const res = await call(videosRoute.GET, {
      token: 'reader',
      path: `/api/studio/library/videos?category=lic${RUN}&limit=100`,
    });
    expect(res.status).toBe(200);
    const found = listIds(res.json);
    expect(found).toContain(ids.licensed);
    expect(found).toContain(ids.licensed2);
    expect(found).not.toContain(ids.unlicensed);
  });

  it('POST /library/videos/:id/similar excludes licence-less neighbours', async () => {
    const res = await call(similarRoute.POST, {
      method: 'POST',
      token: 'reader',
      params: { id: ids.licensed as string },
      body: { limit: 50 },
    });
    expect(res.status).toBe(200);
    const found = listIds(res.json);
    expect(found).toContain(ids.licensed2);
    expect(found).not.toContain(ids.unlicensed);
  });

  it('similar of an unlicensed source is a 404 (the row is unusable)', async () => {
    const res = await call(similarRoute.POST, {
      method: 'POST',
      token: 'reader',
      params: { id: ids.unlicensed as string },
      body: {},
    });
    expect(res.status).toBe(404);
  });

  it('GET /library/recommended excludes licence-less rows', async () => {
    const res = await call(recommendedRoute.GET, {
      token: 'reader',
      path: `/api/studio/library/recommended?businessId=${biz}&category=lic${RUN}&limit=50`,
    });
    expect(res.status).toBe(200);
    const found = listIds(res.json);
    expect(found).toContain(ids.licensed);
    expect(found).not.toContain(ids.unlicensed);
  });

  it('detail and blueprint of an unlicensed row are 404', async () => {
    const detail = await call(videoRoute.GET, {
      token: 'reader',
      params: { id: ids.unlicensed as string },
    });
    expect(detail.status).toBe(404);
    const blueprint = await call(blueprintRoute.GET, {
      token: 'reader',
      params: { libraryVideoId: ids.unlicensed as string },
    });
    expect(blueprint.status).toBe(404);
    const ok = await call(videoRoute.GET, {
      token: 'reader',
      params: { id: ids.licensed as string },
    });
    expect(ok.status).toBe(200);
  });
});
