import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as adminIngestRoute from '../../src/app/api/studio/admin/library/ingest/route';
import * as adminRetireRoute from '../../src/app/api/studio/admin/library/videos/[id]/retire/route';
import * as adminVideoRoute from '../../src/app/api/studio/admin/library/videos/[id]/route';
import * as blueprintRoute from '../../src/app/api/studio/library/blueprint/[libraryVideoId]/route';
import * as categoriesRoute from '../../src/app/api/studio/library/categories/route';
import * as recommendedRoute from '../../src/app/api/studio/library/recommended/route';
import * as similarRoute from '../../src/app/api/studio/library/videos/[id]/similar/route';
import * as videoRoute from '../../src/app/api/studio/library/videos/[id]/route';
import * as videosRoute from '../../src/app/api/studio/library/videos/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { ingestLibraryVideo } from '../../src/lib/studio/library/ingest';
import { seedTaxonomy } from '../../src/lib/studio/library/taxonomy';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness, PROFILE_JSON } from '../helpers/pipeline-harness';

// BACKLOG 9.1–9.7: ingest reference videos (admin API → worker → scene detection, keyframes,
// transcript, Claude analysis, embedding), browse/search them, and generate TEMPLATE and
// INSPIRE projects from a reference, through real routes, workers and Postgres/pgvector.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const URL_A = `https://corpus.example/${RUN}/a.mp4`;
const URL_B = `https://corpus.example/${RUN}/b.mp4`;
const URL_C = `https://corpus.example/${RUN}/c.mp4`;

const corpus = (async (input: string | URL | Request) =>
  new Response(new TextEncoder().encode(`video bytes for ${String(input)}`), {
    headers: { 'content-type': 'video/mp4' },
  })) as typeof fetch;

describe.skipIf(!hasDb)(
  'video library API + reference-guided generation',
  { timeout: 120_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `api-library-${randomUUID()}`;
    const biz = `biz-${randomUUID()}`;
    const tokens = {
      // 15.D2 / A10.3: TEMPLATE mode needs Plus (gate covered in test/api/p15-d-tiers.test.ts).
      owner: { ...tenant(org), organisation: { id: org, planTier: 'PLUS' } },
      staff: tenant(org, ['studio:project:read', 'studio:admin:library']),
      reader: tenant(org, ['studio:project:read']),
    };
    let h: ReturnType<typeof createHarness>;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      await seedOverlayPresets(db);
      await seedTaxonomy(
        db,
        JSON.parse(
          readFileSync(join(__dirname, '../../prisma/data/library-taxonomy.json'), 'utf8'),
        ),
      );
      h = createHarness(db, { pageFetch: corpus });
      installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
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
      const items = await db.videoLibraryItem.findMany({
        where: { sourceUrl: { startsWith: `https://corpus.example/${RUN}/` } },
        select: { id: true },
      });
      const itemIds = items.map((i) => i.id);
      await db.$executeRaw`DELETE FROM studio.video_library_embeddings WHERE "libraryItemId" = ANY(${itemIds})`;
      await db.videoLibraryAnalysis.deleteMany({ where: { libraryItemId: { in: itemIds } } });
      await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: itemIds } } });
      const projects = await db.videoProject.findMany({
        where: { organisationId: org },
        select: { id: true },
      });
      const projectIds = projects.map((p) => p.id);
      const shots = await db.videoShot.findMany({
        where: { script: { projectId: { in: projectIds } } },
        select: { id: true },
      });
      await db.textOverlay.deleteMany({ where: { shotId: { in: shots.map((s) => s.id) } } });
      await db.videoShot.deleteMany({ where: { script: { projectId: { in: projectIds } } } });
      await db.videoScript.deleteMany({ where: { projectId: { in: projectIds } } });
      await db.videoBrief.deleteMany({ where: { projectId: { in: projectIds } } });
      await db.videoRender.deleteMany({ where: { projectId: { in: projectIds } } });
      await db.videoAsset.deleteMany({ where: { projectId: { in: projectIds } } });
      await db.videoProject.deleteMany({ where: { id: { in: projectIds } } });
      await db.videoLibraryItem.deleteMany({ where: { id: { in: itemIds } } });
      await db.businessProfile.deleteMany({ where: { organisationId: org } });
      await db.providerJob.deleteMany({
        where: { organisationId: { in: [org, 'postmind-platform'] } },
      });
      await db.$disconnect();
    });

    it('ingests reference videos through the admin API and worker', async () => {
      expect(
        (
          await call(adminIngestRoute.POST, {
            method: 'POST',
            token: 'reader',
            body: { items: [] },
          })
        ).status,
      ).toBe(403);
      const res = await call(adminIngestRoute.POST, {
        method: 'POST',
        token: 'staff',
        body: {
          items: [
            { sourceUrl: URL_A, licenseScenario: 'LICENSED', tags: ['Bread'], title: 'Dawn bake' },
            { sourceUrl: URL_B, licenseScenario: 'SCRAPED', category: 'lifestyle/food/baking' },
          ],
        },
      });
      expect(res.status).toBe(202);
      expect((res.json.queued as unknown[]).length).toBe(2);
      const drained = await drainInline(h.queue, h.deps);
      expect(drained.failedJobs).toEqual([]);

      const a = await db.videoLibraryItem.findFirstOrThrow({
        where: { sourceUrl: URL_A },
        include: { analysis: true, license: true, category: true },
      });
      ids.a = a.id;
      expect(a.title).toBe('Dawn bake');
      expect(a.tags).toEqual(['bread', 'bakery', 'behind the scenes']);
      expect(a.category.slug).toBe('community/behind-the-scenes/production');
      expect(a.aspectRatio).toBe('9:16');
      expect(a.analysis?.shotCount).toBe(3);
      expect(a.analysis?.paceTag).toBe('fast-cut');
      expect(a.analysis?.transcript).toMatchObject({
        text: expect.stringContaining('Ever wondered'),
      });
      expect(a.analysis?.overlayTimeline).toEqual([
        expect.objectContaining({ text: 'Ever wondered?', startSec: 0, endSec: 2.5 }),
        expect.objectContaining({ text: 'Subscribe', startSec: 6, endSec: 15 }),
      ]);
      expect(a.license?.allowedModes).toEqual(['TEMPLATE', 'INSPIRE']);

      const b = await db.videoLibraryItem.findFirstOrThrow({
        where: { sourceUrl: URL_B },
        include: { license: true, category: true },
      });
      ids.b = b.id;
      expect(b.category.slug).toBe('lifestyle/food/baking'); // curator's category wins
      expect(b.license?.allowedModes).toEqual(['INSPIRE']); // scenario 3: no TEMPLATE

      // Claude saw the keyframes as images.
      const analysisCall = h.adapters.anthropic.requests.find((r) =>
        (r as { system?: string }).system?.includes('analyse short-form'),
      ) as { images?: unknown[] } | undefined;
      expect(analysisCall?.images).toHaveLength(3);

      // Same bytes again → no duplicate.
      const again = await ingestLibraryVideo(
        h.deps,
        { sourceUrl: URL_A, licenseScenario: 'LICENSED', tags: [] },
        'STANDARD',
      );
      expect(again).toEqual({ libraryItemId: a.id, created: false });

      // Without a transcription provider, the video is indexed without speech.
      const noSpeech = createHarness(db, { pageFetch: corpus, noTranscription: true });
      const c = await ingestLibraryVideo(
        noSpeech.deps,
        { sourceUrl: URL_C, licenseScenario: 'OWNED', tags: [] },
        'STANDARD',
      );
      ids.c = c.libraryItemId;
      const cAnalysis = await db.videoLibraryAnalysis.findUniqueOrThrow({
        where: { libraryItemId: c.libraryItemId },
      });
      expect(cAnalysis.transcript).toMatchObject({
        skipped: 'no transcription provider available',
      });
    });

    it('browses, searches and recommends', async () => {
      const list = await call(videosRoute.GET, {
        token: 'reader',
        path: '/api/studio/library/videos?category=community&tags=bread',
      });
      const data = list.json.data as Array<Record<string, unknown>>;
      expect(data.map((v) => v.id)).toEqual([ids.a]);
      expect(data[0]).not.toHaveProperty('s3Key');
      expect(String(data[0]?.thumbnailUrl)).toContain('signed.example');

      const detail = await call(videoRoute.GET, { token: 'reader', params: { id: ids.a ?? '' } });
      expect(detail.json.video).toMatchObject({
        previewExpiresInSec: 600,
        allowedModes: ['TEMPLATE', 'INSPIRE'],
      });
      expect(detail.json.video).not.toHaveProperty('sourceUrl');

      const categories = await call(categoriesRoute.GET, { token: 'reader' });
      const roots = categories.json.data as Array<{ name: string; children: unknown[] }>;
      expect(roots.map((r) => r.name)).toEqual([
        'Business',
        'Lifestyle',
        'Education',
        'Entertainment',
        'News and commentary',
        'Personal brand',
        'Product marketing',
        'Community',
      ]);

      const similar = await call(similarRoute.POST, {
        method: 'POST',
        token: 'reader',
        params: { id: ids.a ?? '' },
        body: { limit: 5 },
      });
      const hits = similar.json.data as Array<{ id: string; similarity: number }>;
      expect(hits.map((x) => x.id)).toEqual(expect.arrayContaining([ids.b, ids.c]));
      expect(hits.some((x) => x.id === ids.a)).toBe(false);

      const recommended = await call(recommendedRoute.GET, {
        token: 'reader',
        path: `/api/studio/library/recommended?businessId=${biz}&limit=10`,
      });
      expect((recommended.json.data as unknown[]).length).toBeGreaterThanOrEqual(3);

      const bp = await call(blueprintRoute.GET, {
        token: 'reader',
        params: { libraryVideoId: ids.a ?? '' },
      });
      expect(bp.json.blueprint).toMatchObject({ shotCount: 3, totalDurationSec: 15 });
      const bpB = await call(blueprintRoute.GET, {
        token: 'reader',
        params: { libraryVideoId: ids.b ?? '' },
      });
      expect(bpB.json.blueprint).toBeNull();
      expect(bpB.json.styleSignature).toMatchObject({ paceTag: 'fast-cut' });
    });

    const createReferenceProject = (referenceVideoId: string, referenceMode: string) =>
      call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: {
          name: `Reference ${referenceMode}`,
          businessId: biz,
          sourceType: 'LIBRARY_REFERENCE',
          referenceVideoId,
          referenceMode,
          brief: { rawInput: 'Launch video for our sourdough subscription' },
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
        },
      });

    it('generates a TEMPLATE project that follows the reference structure', async () => {
      expect((await createReferenceProject(ids.b ?? '', 'TEMPLATE')).status).toBe(409); // scraped
      const created = await createReferenceProject(ids.a ?? '', 'TEMPLATE');
      expect(created.status).toBe(201);
      const projectId = (created.json.project as { id: string }).id;
      await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: projectId },
        body: {},
      });
      const drained = await drainInline(h.queue, h.deps);
      expect(drained.failedJobs).toEqual([]);

      const project = await db.videoProject.findUniqueOrThrow({
        where: { id: projectId },
        include: {
          scripts: {
            include: {
              shots: {
                orderBy: { sortOrder: 'asc' },
                include: { overlays: { orderBy: { createdAt: 'asc' } } },
              },
            },
          },
        },
      });
      expect(project.state).toBe('READY_FOR_REVIEW');
      const shots = project.scripts[0]?.shots ?? [];
      expect(shots.map((s) => s.durationSec)).toEqual([2.5, 3.5, 9]);
      expect(shots.map((s) => s.transitionOut)).toEqual(['cut', 'cut', 'cut']);
      // Hook overlay inherits the reference's "bold-centre" style → Bold Centre preset. The first
      // shot also carries narration captions (13.6); the hook is planned first (layer 2), so it is
      // the oldest row — reading overlays without an order was flaky on CI.
      expect(shots[0]?.overlays[0]).toMatchObject({ strokeColor: '#000000', strokeWidthPx: 3 });

      const scriptCall = h.adapters.anthropic.requests.find((r) =>
        (r as { prompt?: string }).prompt?.includes('STRUCTURE TEMPLATE'),
      ) as { prompt: string } | undefined;
      expect(scriptCall?.prompt).toContain('Exactly 3 shots');
    });

    it('generates an INSPIRE project with only the style signature', async () => {
      const created = await createReferenceProject(ids.b ?? '', 'INSPIRE');
      expect(created.status).toBe(201);
      const projectId = (created.json.project as { id: string }).id;
      const before = h.adapters.anthropic.requests.length;
      await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: projectId },
        body: {},
      });
      await drainInline(h.queue, h.deps);
      const prompts = h.adapters.anthropic.requests
        .slice(before)
        .map((r) => (r as { prompt?: string }).prompt ?? '');
      expect(prompts.some((p) => p.includes('Generate in this style: fast-cut pacing'))).toBe(true);
      expect(prompts.some((p) => p.includes('STRUCTURE TEMPLATE'))).toBe(false);
    });

    it('lets staff edit and retire items', async () => {
      const patched = await call(adminVideoRoute.PATCH, {
        method: 'PATCH',
        token: 'staff',
        params: { id: ids.c ?? '' },
        body: {
          tags: ['Kitchen'],
          category: 'education/tutorials/cooking-how-to',
          licenseScenario: 'SCRAPED',
        },
      });
      expect(patched.status).toBe(200);
      const c = await db.videoLibraryItem.findUniqueOrThrow({
        where: { id: ids.c },
        include: { license: true, category: true },
      });
      expect(c.tags).toEqual(['kitchen']);
      expect(c.category.slug).toBe('education/tutorials/cooking-how-to');
      expect(c.license?.allowedModes).toEqual(['INSPIRE']);
      expect(
        (
          await call(adminVideoRoute.PATCH, {
            method: 'PATCH',
            token: 'staff',
            params: { id: ids.c ?? '' },
            body: { category: 'nope' },
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await call(adminRetireRoute.POST, {
            method: 'POST',
            token: 'reader',
            params: { id: ids.c ?? '' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(adminRetireRoute.POST, {
            method: 'POST',
            token: 'staff',
            params: { id: ids.c ?? '' },
          })
        ).status,
      ).toBe(200);
      expect(
        (await call(videoRoute.GET, { token: 'reader', params: { id: ids.c ?? '' } })).status,
      ).toBe(404);
      const similar = await call(similarRoute.POST, {
        method: 'POST',
        token: 'reader',
        params: { id: ids.a ?? '' },
        body: {},
      });
      expect((similar.json.data as Array<{ id: string }>).some((x) => x.id === ids.c)).toBe(false);
      expect((await createReferenceProject(ids.c ?? '', 'INSPIRE')).status).toBe(400);
    });
  },
);
