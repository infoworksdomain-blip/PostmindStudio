import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as autoPopulateRoute from '../../src/app/api/studio/projects/[id]/auto-populate/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectSlidesRoute from '../../src/app/api/studio/projects/[id]/slides/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as reorderRoute from '../../src/app/api/studio/slides/[id]/reorder/route';
import * as slideRoute from '../../src/app/api/studio/slides/[id]/route';
import * as templatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { ingestImage } from '../../src/lib/studio/images/ingest';
import { embedMissing, libraryDepsFrom } from '../../src/lib/studio/images/library';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { seedSlideshowTemplates } from '../../src/lib/studio/slideshow/seed-templates';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { fakePng } from '../helpers/png';

// BACKLOG 7.1–7.7 end to end: templates → SLIDESHOW project → auto-populate from the image
// library (+ generation for gaps) → slide edits → generate → slideshow composition → quality
// gate, through the real routes, workers and Postgres/pgvector.

const hasDb = Boolean(process.env.DATABASE_URL);

type Slide = {
  id: string;
  sortOrder: number;
  slideType: string;
  imageAssetId: string | null;
  content: Record<string, unknown>;
  problem: string | null;
};

describe.skipIf(!hasDb)('slideshow API + pipeline', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-slides-${randomUUID()}`;
  const biz = `biz-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    other: tenant(`api-slides-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let templates: Array<{ id: string; category: string; organisationId: string | null }>;

  beforeAll(async () => {
    await seedSlideshowTemplates(db);
    // A small library: two photos whose descriptions match two listicle entries.
    const seed = createHarness(db);
    const scope = { organisationId: org, businessId: biz, planTier: 'STANDARD' as const };
    for (const [i, alt] of ['Slow 48-hour ferment sourdough', 'Loaves baked at dawn'].entries()) {
      await ingestImage(libraryDepsFrom(seed.deps), {
        organisationId: org,
        businessId: biz,
        source: 'UPLOAD',
        bytes: fakePng(1080, 1920, 500 + i),
        altText: alt,
      });
    }
    await embedMissing({ db, providers: seed.deps }, scope);
  });

  beforeEach(() => {
    h = createHarness(db);
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.slideshowTemplate.deleteMany({ where: { organisationId: org } });
    await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const slidesOf = async (projectId: string, token = 'reader') =>
    (await call(projectSlidesRoute.GET, { token, params: { id: projectId } })).json.data as Slide[];

  const createSlideshow = (slideshow: Record<string, unknown>, token = 'owner') =>
    call(projectsRoute.POST, {
      method: 'POST',
      token,
      body: {
        name: 'Sourdough listicle',
        businessId: biz,
        sourceType: 'SLIDESHOW',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
        slideshow,
      },
    });

  it('lists the eight built-in templates', async () => {
    const res = await call(templatesRoute.GET, { token: 'reader' });
    templates = res.json.data as typeof templates;
    expect(templates.filter((t) => t.organisationId === null).map((t) => t.category)).toEqual(
      expect.arrayContaining([
        'photo_dump',
        'listicle_5',
        'listicle_10',
        'before_after',
        'product_showcase',
        'quote_reel',
        'statistic_reel',
        'team_introduction',
      ]),
    );
    const filtered = await call(templatesRoute.GET, {
      token: 'reader',
      path: '/api/studio/slideshow-templates?category=quote_reel',
    });
    expect((filtered.json.data as unknown[]).length).toBe(1);
  });

  it('builds a listicle from a topic: auto-populate, edit, generate, compose', async () => {
    const listicle = templates.find((t) => t.category === 'listicle_5');
    const created = await createSlideshow({
      templateId: listicle?.id,
      topic: 'Why our sourdough is different',
    });
    expect(created.status).toBe(201);
    const projectId = (created.json.project as { id: string }).id;

    let slides = await slidesOf(projectId);
    expect(slides.map((s) => s.slideType)).toEqual([
      'TEXT_CARD',
      'IMAGE_STILL',
      'IMAGE_STILL',
      'IMAGE_STILL',
      'IMAGE_STILL',
      'IMAGE_STILL',
      'TEXT_CARD',
    ]);
    expect(slides.every((s) => s.problem)).toBe(true);

    // Generating an incomplete slideshow fails with the reasons, spending nothing on composition.
    await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: projectId },
      body: {},
    });
    await drainInline(h.queue, h.deps);
    const failed = await call(projectRoute.GET, { token: 'reader', params: { id: projectId } });
    expect(failed.json.project).toMatchObject({ state: 'FAILED' });
    expect(String((failed.json.project as { errorReason: string }).errorReason)).toContain(
      'slideshow_incomplete',
    );
    expect(h.adapters.shotstack.requests).toHaveLength(0);

    const populate = await call(autoPopulateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: projectId },
    });
    expect(populate.status).toBe(202);
    expect(
      (await call(projectRoute.GET, { token: 'reader', params: { id: projectId } })).json.project,
    ).toMatchObject({ state: 'SCANNING' });
    await drainInline(h.queue, h.deps);

    slides = await slidesOf(projectId);
    expect(slides.map((s) => s.problem)).toEqual(Array(7).fill(null));
    expect(slides[0]?.content.text).toBe('5 reasons Leeds loves our sourdough');
    expect(slides[1]?.content).toMatchObject({ text: 'Slow 48-hour ferment', number: 1 });
    const imageIds = slides.flatMap((s) => (s.imageAssetId ? [s.imageAssetId] : []));
    expect(new Set(imageIds).size).toBe(5); // no image reused
    const generated = await db.imageLibraryItem.count({
      where: { organisationId: org, businessId: biz, source: 'GENERATED' },
    });
    expect(generated).toBe(3); // 2 library matches + 3 generated for the gaps
    const project = await db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.state).toBe('FAILED'); // back to where it came from

    // Edits: change a caption, move the CTA to second place and back, add and remove a slide.
    const cta = slides[6] as Slide;
    const edited = await call(slideRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: cta.id },
      body: { content: { text: 'Subscribe <today>' }, durationSec: 9 },
    });
    expect(edited.status).toBe(200);
    expect((edited.json.slide as { durationSec: number }).durationSec).toBe(2.5); // clamped
    const moved = await call(reorderRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: cta.id },
      body: { newSortOrder: 1 },
    });
    expect((moved.json.data as Slide[]).map((s) => s.id)[1]).toBe(cta.id);
    await call(reorderRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: cta.id },
      body: { newSortOrder: 99 },
    });
    const added = await call(projectSlidesRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: projectId },
      body: { slideType: 'TEXT_CARD', sortOrder: 0, content: { text: 'Temporary' } },
    });
    expect(added.status).toBe(201);
    const addedId = (added.json.slide as Slide).id;
    expect((await slidesOf(projectId))[0]?.id).toBe(addedId);
    await call(slideRoute.DELETE, { method: 'DELETE', token: 'owner', params: { id: addedId } });
    slides = await slidesOf(projectId);
    expect(slides.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(slides[6]?.id).toBe(cta.id);

    const run = await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: projectId },
      body: {},
    });
    expect(run.status).toBe(202);
    const drained = await drainInline(h.queue, h.deps);
    expect(drained.failedJobs).toEqual([]);
    const done = await db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(done.state).toBe('READY_FOR_REVIEW');

    const request = h.adapters.shotstack.requests[0] as unknown as {
      edit: {
        timeline: { tracks: Array<{ clips: Array<{ asset: { type: string; html?: string } }> }> };
      };
    };
    const [textTrack, visualTrack] = request.edit.timeline.tracks;
    expect(visualTrack?.clips).toHaveLength(7);
    expect(visualTrack?.clips.filter((c) => c.asset.type === 'image')).toHaveLength(5);
    expect(JSON.stringify(textTrack)).toContain('1. Slow 48-hour ferment');
    expect(JSON.stringify(visualTrack)).toContain('Subscribe &lt;today&gt;');
    expect(h.adapters.runway.requests).toHaveLength(0); // no AI video clips for slideshows
    expect(await db.videoRender.count({ where: { projectId } })).toBe(1);

    // Slides are locked while the pipeline runs and editable again for review.
    const saved = await call(templatesRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { projectId, name: 'Our listicle', category: 'house_listicle' },
    });
    expect(saved.status).toBe(201);
    const mine = await call(templatesRoute.GET, { token: 'reader' });
    expect((mine.json.data as typeof templates).some((t) => t.organisationId === org)).toBe(true);
    expect(
      (await call(templatesRoute.GET, { token: 'other' })).json.data as typeof templates,
    ).not.toContainEqual(expect.objectContaining({ organisationId: org }));
  });

  it('validates slideshow inputs and scopes slides to the organisation', async () => {
    const byCategory = (c: string) => templates.find((t) => t.category === c)?.id;
    expect((await createSlideshow({ templateId: byCategory('listicle_5') })).status).toBe(400);
    expect((await createSlideshow({ templateId: byCategory('quote_reel') })).status).toBe(400);
    expect(
      (await createSlideshow({ templateId: byCategory('before_after'), beforeImageId: 'x' }))
        .status,
    ).toBe(400);
    expect((await createSlideshow({ templateId: 'nope' })).status).toBe(400);
    expect((await createSlideshow({})).status).toBe(400);
    const foreignImage = await createSlideshow({
      slides: [{ slideType: 'IMAGE_STILL', imageAssetId: 'not-in-library' }],
    });
    expect(foreignImage.status).toBe(400);

    const quotes = await createSlideshow({
      templateId: byCategory('quote_reel'),
      quotes: [
        { text: 'Best bread in Leeds', author: 'Sam' },
        { text: 'Worth the early start' },
        { text: 'My Saturday ritual', author: 'Priya' },
      ],
    });
    expect(quotes.status).toBe(201);
    const projectId = (quotes.json.project as { id: string }).id;
    const slides = await slidesOf(projectId);
    expect(slides.map((s) => s.slideType)).toEqual(['QUOTE', 'QUOTE', 'QUOTE']);
    expect(slides.every((s) => s.problem === null)).toBe(true);

    expect(
      (await call(projectSlidesRoute.GET, { token: 'other', params: { id: projectId } })).status,
    ).toBe(404);
    expect(
      (
        await call(slideRoute.PATCH, {
          method: 'PATCH',
          token: 'other',
          params: { id: slides[0]?.id ?? '' },
          body: { durationSec: 3 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(slideRoute.PATCH, {
          method: 'PATCH',
          token: 'reader',
          params: { id: slides[0]?.id ?? '' },
          body: { durationSec: 3 },
        })
      ).status,
    ).toBe(403);

    const brief = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'Brief video',
        businessId: biz,
        brief: { rawInput: 'Launch video' },
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      },
    });
    const briefId = (brief.json.project as { id: string }).id;
    expect(
      (await call(projectSlidesRoute.GET, { token: 'reader', params: { id: briefId } })).status,
    ).toBe(409);
    expect(
      (
        await call(autoPopulateRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: briefId },
        })
      ).status,
    ).toBe(409);
  });
});
