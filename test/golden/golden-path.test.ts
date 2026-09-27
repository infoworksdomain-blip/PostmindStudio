import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as adminIngestRoute from '../../src/app/api/studio/admin/library/ingest/route';
import * as killSwitchRoute from '../../src/app/api/studio/admin/kill-switch/route';
import * as analyticsOverviewRoute from '../../src/app/api/studio/analytics/overview/route';
import * as analyticsPublicationRoute from '../../src/app/api/studio/analytics/publications/[id]/route';
import * as brandKitsRoute from '../../src/app/api/studio/brand-kits/route';
import * as profileRoute from '../../src/app/api/studio/businesses/[id]/business-profile/route';
import * as scanWebsiteRoute from '../../src/app/api/studio/businesses/[id]/scan-website/route';
import * as imageLibraryRoute from '../../src/app/api/studio/image-library/route';
import * as imageSearchRoute from '../../src/app/api/studio/image-library/search/route';
import * as libraryVideosRoute from '../../src/app/api/studio/library/videos/route';
import * as autoPopulateRoute from '../../src/app/api/studio/projects/[id]/auto-populate/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectSlidesRoute from '../../src/app/api/studio/projects/[id]/slides/route';
import * as projectScriptsRoute from '../../src/app/api/studio/projects/[id]/scripts/route';
import * as rejectRoute from '../../src/app/api/studio/projects/[id]/reject/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as cancelPublicationRoute from '../../src/app/api/studio/publications/[id]/cancel/route';
import * as retryRoute from '../../src/app/api/studio/publications/[id]/retry/route';
import * as takedownRoute from '../../src/app/api/studio/publications/[id]/takedown/route';
import * as downloadRoute from '../../src/app/api/studio/renders/[id]/download/route';
import * as forceApproveRoute from '../../src/app/api/studio/renders/[id]/force-approve/route';
import * as bulkOverlayRoute from '../../src/app/api/studio/renders/[id]/overlays/bulk/route';
import * as previewRoute from '../../src/app/api/studio/renders/[id]/preview/route';
import * as rerenderRoute from '../../src/app/api/studio/renders/[id]/rerender/route';
import * as scanRoute from '../../src/app/api/studio/scans/[id]/route';
import * as shotOverlaysRoute from '../../src/app/api/studio/shots/[id]/overlays/route';
import * as regenerateShotRoute from '../../src/app/api/studio/shots/[id]/regenerate/route';
import * as templatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import { PlatformError } from '../../src/lib/errors';
import type { MetricsFetcher } from '../../src/lib/studio/analytics/fetchers';
import type { MetricSnapshot } from '../../src/lib/studio/analytics/store';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { getKillSwitch } from '../../src/lib/studio/kill-switch';
import { seedTaxonomy } from '../../src/lib/studio/library/taxonomy';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { seedSlideshowTemplates } from '../../src/lib/studio/slideshow/seed-templates';
import { call, tenant } from '../helpers/api-harness';
import {
  approve,
  approvedTikTokProject,
  BUSINESS_ID,
  briefBody,
  cleanupGolden,
  connect,
  createProject,
  drain,
  fakePostId,
  generate,
  getProject,
  getPublication,
  LIBRARY_URL_PREFIX,
  ORG_PREFIX,
  publish,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';
import { goldenWebsite } from './website-fixture';

// BACKLOG 12.7 — golden-path regression suite (playbook Workstream H-07). Each journey is what a
// user does end to end, driven through the real route handlers (tenant → capability → handler),
// with the jobs those routes enqueue drained through the real workers on the inline queue, real
// Postgres/pgvector, scripted AI providers, in-memory storage and recording platform publishers.
//
//   GP-01  Brief → generate → review (preview/download) → approve → publish now
//   GP-02  Scheduled publication waits, then fires and publishes; a second one is cancelled
//   GP-03  Multi-format: one brief → TikTok + Shorts + Reels renders → each published
//   GP-04  Quality gate failure → force-approve with a note → approve → publish
//   GP-05  Reject with a note → regenerate one shot with a new prompt → re-review → approve
//   GP-06  Slideshow from a built-in template → auto-populate slides → compose → approve
//   GP-07  Library reference project: ingest a reference, then TEMPLATE and INSPIRE projects
//   GP-08  Overlays: add a styled shot overlay + whole-video watermark → re-render → publish
//   GP-09  Website scan → business profile → image library → semantic search
//   GP-10  Business default brand kit applied across ideation, overlays and composition
//   GP-11  Publication fails on the platform → retry → published
//   GP-12  Take down a published post (and a clean refusal where the platform has no delete)
//   GP-13  Kill switch: workspace freeze halts one org's run while another org completes
//   GP-14  Analytics polled after publish → per-publication detail and overview
//   GP-15  Project budget cap stops asset spend before the expensive provider is called
//
// Not covered (not implemented in the code): the AUTO_APPROVE review policy and the
// AUTO_ON_APPROVAL publish policy are stored on the project but nothing acts on them yet, so a
// generated project always waits for a human approval and never auto-publishes.

const hasDb = Boolean(process.env.DATABASE_URL);
// Seeding and cleanup touch hundreds of rows; the single-connection local DB is slow under load.
const HOOK_TIMEOUT_MS = 120_000;
const KILL_SWITCH_CAPS = ['studio:admin:kill-switch:read', 'studio:admin:kill-switch:write'];

type Edit = { timeline: { fonts?: Array<{ src: string }>; tracks: unknown[] } };
type Shot = { id: string; sortOrder: number; assetId: string | null; sceneDescription: string };

describe.skipIf(!hasDb)('golden-path journeys (BACKLOG 12.7)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await seedOverlayPresets(db);
    await seedSlideshowTemplates(db);
    await seedTaxonomy(
      db,
      JSON.parse(readFileSync(join(__dirname, '../../prisma/data/library-taxonomy.json'), 'utf8')),
    );
  }, HOOK_TIMEOUT_MS);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    (await getKillSwitch()).invalidate();
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const lastEdit = (j: Journey) =>
    (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
  const shotsOf = async (projectId: string) =>
    (
      (await call(projectScriptsRoute.GET, { token: 'reader', params: { id: projectId } })).json
        .data as Array<{ shots: Shot[] }>
    ).flatMap((s) => s.shots);

  it('GP-01 brief → generate → review → approve → publish now', async () => {
    const j = startJourney(db, 'gp01');
    const id = await createProject(j);
    expect((await getProject(j, id)).state).toBe('DRAFT');

    const ready = await generate(j, id);
    expect(ready.state).toBe('READY_FOR_REVIEW');
    const [render] = await rendersOf(j, id);
    expect(render).toMatchObject({ targetPlatform: 'tiktok', qualityCheckState: 'PASSED' });
    const renderId = render?.id ?? '';

    // Review: watch the preview, download the master.
    const preview = await call(previewRoute.GET, { token: 'reader', params: { id: renderId } });
    expect(String(preview.json.url)).toContain('signed.example/renders/');
    const download = await call(downloadRoute.GET, { token: 'owner', params: { id: renderId } });
    expect(download.status).toBe(200);

    await approve(j, id);
    const conn = await connect(j, 'tiktok');
    const pubId = await publish(j, {
      renderId,
      platform: 'tiktok',
      connectionId: conn.id,
      caption: 'Fresh sourdough, every week',
      hashtags: ['#Leeds'],
    });
    expect((await getProject(j, id)).state).toBe('PUBLISHING');
    await drain(j);

    expect(await getPublication(j, pubId)).toMatchObject({
      state: 'PUBLISHED',
      platformPostId: fakePostId('tiktok', 'gp01', 1),
    });
    expect((await getProject(j, id)).state).toBe('PUBLISHED');
    expect(j.h.publishers.tiktok.published[0]).toMatchObject({
      accessToken: 'tiktok-access',
      aiGenerated: true,
    });
    expect(j.h.attributions).toEqual([expect.objectContaining({ publicationId: pubId })]);
    expect(j.api.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'studio.project.create',
        'studio.project.generate',
        'studio.render.download',
        'studio.project.approve',
      ]),
    );
  });

  it('GP-02 scheduled publication waits, then fires; a cancelled one never publishes', async () => {
    const j = startJourney(db, 'gp02');
    j.h.queue.defer.add('fire-scheduled-publication');
    const { projectId, render } = await approvedTikTokProject(j);
    const conn = await connect(j, 'tiktok');
    const later = new Date(Date.now() + 3_600_000).toISOString();

    const pubId = await publish(j, {
      renderId: render.id,
      platform: 'tiktok',
      connectionId: conn.id,
      scheduledFor: later,
    });
    await drain(j);
    expect((await getPublication(j, pubId)).state).toBe('SCHEDULED');
    expect(j.h.publishers.tiktok.published).toHaveLength(0);
    expect(
      (await db.scheduledPublication.findUniqueOrThrow({ where: { publicationId: pubId } })).state,
    ).toBe('PENDING');

    // A second scheduled post for another account is cancelled before it fires.
    const other = await connect(j, 'tiktok');
    const cancelledId = await publish(j, {
      renderId: render.id,
      platform: 'tiktok',
      connectionId: other.id,
      scheduledFor: later,
    });
    const cancelled = await call(cancelPublicationRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: cancelledId },
    });
    expect(cancelled.status).toBe(200);

    // The scheduled time arrives.
    expect(j.h.queue.release('fire-scheduled-publication')).toBe(2);
    await drain(j);
    expect((await getPublication(j, pubId)).state).toBe('PUBLISHED');
    expect((await getPublication(j, cancelledId)).state).toBe('CANCELLED');
    expect(j.h.publishers.tiktok.published).toHaveLength(1);
    expect(
      (await db.scheduledPublication.findUniqueOrThrow({ where: { publicationId: pubId } })).state,
    ).toBe('FIRED');
    expect((await getProject(j, projectId)).state).toBe('PUBLISHED');
  });

  it('GP-03 one brief renders TikTok, Shorts and Reels, each published to its platform', async () => {
    const j = startJourney(db, 'gp03');
    const id = await createProject(
      j,
      briefBody({
        targetFormats: [
          { platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 },
          { platform: 'youtube_short', aspectRatio: '9:16', durationSec: 15 },
          { platform: 'instagram_reel', aspectRatio: '9:16', durationSec: 15 },
        ],
      }),
    );
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const renders = await rendersOf(j, id);
    expect(renders.map((r) => r.targetPlatform).sort()).toEqual([
      'instagram_reel',
      'tiktok',
      'youtube_short',
    ]);
    expect(renders.every((r) => r.qualityCheckState === 'PASSED')).toBe(true);
    expect(j.h.adapters.shotstack.requests).toHaveLength(3);

    await approve(j, id);
    const byPlatform = new Map(renders.map((r) => [r.targetPlatform, r.id]));
    const tiktok = await connect(j, 'tiktok');
    const youtube = await connect(j, 'youtube');
    const ids = [
      await publish(j, {
        renderId: byPlatform.get('tiktok'),
        platform: 'tiktok',
        connectionId: tiktok.id,
      }),
      await publish(j, {
        renderId: byPlatform.get('youtube_short'),
        platform: 'youtube_short',
        connectionId: youtube.id,
        title: 'Sourdough at dawn',
      }),
      await publish(j, {
        renderId: byPlatform.get('instagram_reel'),
        platform: 'instagram_reel',
        platformAccountId: 'ig-golden',
        caption: 'Reel time',
      }),
    ];
    await drain(j);
    for (const pubId of ids) expect((await getPublication(j, pubId)).state).toBe('PUBLISHED');
    expect(j.h.publishers.instagram_reel.published[0]).toMatchObject({
      accountId: 'ig-golden',
      accessToken: 'meta-token',
    });
    expect((await getProject(j, id)).state).toBe('PUBLISHED');
  });

  it('GP-04 quality failure → force-approve with a note → approve → publish', async () => {
    const j = startJourney(db, 'gp04', { loudness: -30 });
    const id = await createProject(j);
    const failed = await generate(j, id);
    expect(failed.state).toBe('QUALITY_FAILED');
    expect(failed.errorReason).toContain('audio_present');
    const [render] = await rendersOf(j, id);
    expect(render?.qualityCheckState).toBe('FAILED');

    const forced = await call(forceApproveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render?.id ?? '' },
      body: { note: 'Quiet voiceover is intentional' },
    });
    expect(forced.status).toBe(200);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');

    await approve(j, id);
    const conn = await connect(j, 'tiktok');
    const pubId = await publish(j, {
      renderId: render?.id,
      platform: 'tiktok',
      connectionId: conn.id,
    });
    await drain(j);
    expect((await getPublication(j, pubId)).state).toBe('PUBLISHED');
  });

  it('GP-05 reject → regenerate one shot with a new prompt → re-review → approve', async () => {
    const j = startJourney(db, 'gp05');
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const rejected = await call(rejectRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      body: { note: 'Second shot looks off-brand' },
    });
    expect(rejected.status).toBe(200);
    expect((await getProject(j, id)).state).toBe('REJECTED');

    const before = await shotsOf(id);
    const target = before[1] as Shot;
    const clipsBefore = j.h.adapters.runway.requests.length;
    const regen = await call(regenerateShotRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: target.id },
      body: { prompt: 'Baker pulling loaves from a wood-fired oven' },
    });
    expect(regen.status).toBe(202);
    await drain(j);

    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.runway.requests.length).toBe(clipsBefore + 1); // only that shot
    const after = await shotsOf(id);
    expect(after[1]).toMatchObject({
      sceneDescription: 'Baker pulling loaves from a wood-fired oven',
    });
    expect(after[1]?.assetId).toBeTruthy();
    expect(after[1]?.assetId).not.toBe(target.assetId);
    expect(after[0]?.assetId).toBe(before[0]?.assetId); // untouched shots keep their assets
    expect(await rendersOf(j, id)).toHaveLength(2);
    await approve(j, id, 'Better');
  });

  it('GP-06 slideshow from a template → auto-populate → compose → approve', async () => {
    const j = startJourney(db, 'gp06');
    const templates = (await call(templatesRoute.GET, { token: 'reader' })).json.data as Array<{
      id: string;
      category: string;
    }>;
    const listicle = templates.find((t) => t.category === 'listicle_5');
    const id = await createProject(j, {
      name: 'Five reasons listicle',
      businessId: BUSINESS_ID,
      sourceType: 'SLIDESHOW',
      targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      slideshow: { templateId: listicle?.id, topic: 'Why our sourdough is different' },
    });

    const populate = await call(autoPopulateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
    });
    expect(populate.status).toBe(202);
    await drain(j);
    const slides = (await call(projectSlidesRoute.GET, { token: 'reader', params: { id } })).json
      .data as Array<{ problem: string | null; imageAssetId: string | null }>;
    expect(slides).toHaveLength(7);
    expect(slides.every((s) => s.problem === null)).toBe(true);
    const images = slides.flatMap((s) => (s.imageAssetId ? [s.imageAssetId] : []));
    expect(new Set(images).size).toBe(5);

    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.runway.requests).toHaveLength(0); // stills, not AI clips
    expect(JSON.stringify(lastEdit(j))).toContain('Slow 48-hour ferment');
    await approve(j, id);
  });

  it('GP-07 library reference: ingest, browse, then TEMPLATE and INSPIRE projects', async () => {
    const corpus = (async (input: string | URL | Request) =>
      new Response(new TextEncoder().encode(`golden bytes ${String(input)}`), {
        headers: { 'content-type': 'video/mp4' },
      })) as typeof fetch;
    const staffOrg = `${ORG_PREFIX}-gp07`;
    const j = startJourney(
      db,
      'gp07',
      { pageFetch: corpus },
      { staff: tenant(staffOrg, ['studio:project:read', 'studio:admin:library']) },
    );
    const licensed = `${LIBRARY_URL_PREFIX}licensed.mp4`;
    const scraped = `${LIBRARY_URL_PREFIX}scraped.mp4`;
    const ingest = await call(adminIngestRoute.POST, {
      method: 'POST',
      token: 'staff',
      body: {
        items: [
          { sourceUrl: licensed, licenseScenario: 'LICENSED', title: 'Golden dawn bake' },
          { sourceUrl: scraped, licenseScenario: 'SCRAPED', category: 'lifestyle/food/baking' },
        ],
      },
    });
    expect(ingest.status).toBe(202);
    await drain(j);
    const [a, b] = await Promise.all(
      [licensed, scraped].map((sourceUrl) =>
        db.videoLibraryItem.findFirstOrThrow({ where: { sourceUrl } }),
      ),
    );

    const browse = await call(libraryVideosRoute.GET, {
      token: 'reader',
      path: '/api/studio/library/videos?category=lifestyle&limit=100',
    });
    expect((browse.json.data as Array<{ id: string }>).map((v) => v.id)).toContain(b?.id);

    const reference = (videoId: string, mode: string) =>
      briefBody({
        name: `Reference ${mode}`,
        sourceType: 'LIBRARY_REFERENCE',
        referenceVideoId: videoId,
        referenceMode: mode,
      });
    const templateId = await createProject(j, reference(a?.id ?? '', 'TEMPLATE'));
    expect((await generate(j, templateId)).state).toBe('READY_FOR_REVIEW');
    expect((await shotsOf(templateId)).length).toBe(3); // follows the reference's shot count
    const prompts = () =>
      j.h.adapters.anthropic.requests.map((r) => (r as { prompt?: string }).prompt ?? '');
    expect(prompts().some((p) => p.includes('STRUCTURE TEMPLATE'))).toBe(true);

    const before = prompts().length;
    const inspireId = await createProject(j, reference(b?.id ?? '', 'INSPIRE'));
    expect((await generate(j, inspireId)).state).toBe('READY_FOR_REVIEW');
    const inspirePrompts = prompts().slice(before);
    expect(inspirePrompts.some((p) => p.includes('Generate in this style'))).toBe(true);
    expect(inspirePrompts.some((p) => p.includes('STRUCTURE TEMPLATE'))).toBe(false);
  });

  it('GP-08 overlays: styled shot overlay + watermark → re-render → publish', async () => {
    const j = startJourney(db, 'gp08');
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const [, second] = await shotsOf(id);
    const added = await call(shotOverlaysRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: second?.id ?? '' },
      body: {
        text: 'Baked at 4am',
        startAtSec: 0.5,
        endAtSec: 3,
        style: { animationIn: 'slideInLeft', fillColor: '#FFD400' },
      },
    });
    expect(added.status).toBe(201);
    const [first] = await rendersOf(j, id);
    const watermark = await call(bulkOverlayRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: first?.id ?? '' },
      body: {
        overlay: {
          text: '@leedssourdough',
          startAtSec: 0,
          endAtSec: 15,
          style: { anchorX: 0.85, anchorY: 0.05, fontSizePct: 2 },
        },
      },
    });
    expect(watermark.status).toBe(201);

    const clips = j.h.adapters.runway.requests.length;
    const rerender = await call(rerenderRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: first?.id ?? '' },
    });
    expect(rerender.status).toBe(202);
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.runway.requests.length).toBe(clips); // no new generation spend
    const edit = JSON.stringify(lastEdit(j));
    expect(edit).toContain('Baked at 4am');
    expect(edit).toContain('@leedssourdough');

    const renders = await rendersOf(j, id);
    expect(renders).toHaveLength(2);
    const latest = renders.find((r) => r.id !== first?.id);
    await approve(j, id);
    const conn = await connect(j, 'tiktok');
    const pubId = await publish(j, {
      renderId: latest?.id,
      platform: 'tiktok',
      connectionId: conn.id,
    });
    await drain(j);
    expect((await getPublication(j, pubId)).state).toBe('PUBLISHED');
  });

  it('GP-09 website scan → business profile → image library → search', async () => {
    const { site, pageFetch, stock } = goldenWebsite();
    const j = startJourney(db, 'gp09', { pageFetch, stockSources: [stock] });
    const started = await call(scanWebsiteRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: BUSINESS_ID },
      body: { url: site, ownershipConfirmed: true },
    });
    expect(started.status).toBe(202);
    await drain(j);

    const scan = await call(scanRoute.GET, {
      token: 'reader',
      params: { id: started.json.scanId as string },
    });
    expect(scan.json.scan).toMatchObject({ state: 'SUCCEEDED', robotsBlocked: false });
    const profile = await call(profileRoute.GET, { token: 'reader', params: { id: BUSINESS_ID } });
    expect(profile.json.profile).toMatchObject({ subNiche: 'artisan sourdough subscriptions' });

    const library = await call(imageLibraryRoute.GET, {
      token: 'reader',
      path: `/api/studio/image-library?businessId=${BUSINESS_ID}&limit=100`,
    });
    const items = library.json.data as Array<{ source: string }>;
    expect(items.filter((i) => i.source === 'SCRAPED')).toHaveLength(1);
    expect(items.filter((i) => i.source === 'STOCK').length).toBeGreaterThan(0);

    const search = await call(imageSearchRoute.POST, {
      method: 'POST',
      token: 'reader',
      body: { businessId: BUSINESS_ID, query: 'golden sourdough loaf', limit: 3 },
    });
    expect((search.json.data as Array<{ altText: string }>)[0]?.altText).toBe(
      'Golden sourdough loaf',
    );
  });

  it('GP-10 the business default brand kit shapes ideation, overlays and composition', async () => {
    const j = startJourney(db, 'gp10');
    const kit = await call(brandKitsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        businessId: BUSINESS_ID,
        name: 'Leeds Sourdough brand',
        colourPalette: ['#1B4332', '#F1FAEE'],
        fontPrimary: 'Anton',
        toneKeywords: ['artisanal', 'neighbourly'],
        audienceProfile: 'Leeds professionals 25-40',
        restrictedTopics: ['politics'],
      },
    });
    expect(kit.status).toBe(201);
    expect((kit.json.brandKit as { isDefault: boolean }).isDefault).toBe(true);

    // No brandKitId on the project: the business default applies ("reused on every generation").
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');

    const ideation = j.h.adapters.anthropic.requests.find((r) =>
      (r as { system?: string }).system?.includes('ideation layer'),
    ) as { prompt: string } | undefined;
    expect(ideation?.prompt).toContain('artisanal');
    const [hook] = await db.textOverlay.findMany({
      where: { shot: { script: { projectId: id }, sortOrder: 0 } },
    });
    expect(hook?.fontFamily).toBe('Anton');
    const edit = lastEdit(j);
    expect(edit.timeline.fonts).toEqual(
      expect.arrayContaining([{ src: 'https://fonts.test/Anton.ttf' }]),
    );
    // The end card (TEXT_CARD) is drawn in the brand's colours and font.
    const json = JSON.stringify(edit);
    expect(json).toContain('"background":"#1B4332"');
    expect(json).toContain("font-family: 'Anton'");
  });

  it('GP-11 publication fails on the platform → retry → published', async () => {
    const j = startJourney(db, 'gp11');
    const { projectId, render } = await approvedTikTokProject(j);
    const conn = await connect(j, 'youtube');
    j.h.publishers.youtube_short.behaviour = () => {
      throw new PlatformError('youtube_short', 'content_policy', 'Video rejected', false);
    };
    const pubId = await publish(j, {
      renderId: render.id,
      platform: 'youtube_short',
      connectionId: conn.id,
      title: 'Sourdough',
    });
    await drain(j, { expectClean: false });
    expect((await getPublication(j, pubId)).state).toBe('FAILED');
    expect((await getProject(j, projectId)).state).toBe('PARTIALLY_PUBLISHED');

    j.h.publishers.youtube_short.behaviour = () => ({
      platformPostId: 'yt-golden',
      platformUrl: null,
      metadata: {},
    });
    const retried = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: pubId },
    });
    expect(retried.status).toBe(202);
    await drain(j);
    expect(await getPublication(j, pubId)).toMatchObject({
      state: 'PUBLISHED',
      platformPostId: 'yt-golden',
    });
    expect((await getProject(j, projectId)).state).toBe('PUBLISHED');
  });

  it('GP-12 take down a published post; TikTok refuses cleanly (no delete API)', async () => {
    const j = startJourney(db, 'gp12');
    const { render } = await approvedTikTokProject(j);
    const youtube = await connect(j, 'youtube');
    const tiktok = await connect(j, 'tiktok');
    const ytId = await publish(j, {
      renderId: render.id,
      platform: 'youtube_short',
      connectionId: youtube.id,
      title: 'Dawn bake',
    });
    const ttId = await publish(j, {
      renderId: render.id,
      platform: 'tiktok',
      connectionId: tiktok.id,
    });
    await drain(j);

    const down = await call(takedownRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: ytId },
    });
    expect(down.status).toBe(200);
    expect((await getPublication(j, ytId)).state).toBe('TAKEN_DOWN');
    expect(j.h.publishers.youtube_short.takenDown).toHaveLength(1);
    expect(j.api.audits.map((a) => a.action)).toContain('studio.publication.takedown');

    const refused = await call(takedownRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: ttId },
    });
    expect(refused.status).toBe(409);
    expect((await getPublication(j, ttId)).state).toBe('PUBLISHED');
  });

  it('GP-13 a workspace freeze halts one org while another org completes', async () => {
    const staffOrg = `${ORG_PREFIX}-staff`;
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    const otherOrg = `${ORG_PREFIX}-gp13-other`;
    const j = startJourney(
      db,
      'gp13',
      {},
      { staff: tenant(staffOrg, KILL_SWITCH_CAPS), other: tenant(otherOrg) },
    );
    const frozenId = await createProject(j);
    const otherRes = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'other',
      body: briefBody(),
    });
    const otherId = (otherRes.json.project as { id: string }).id;
    for (const [id, token] of [
      [frozenId, 'owner'],
      [otherId, 'other'],
    ] as const) {
      const res = await call(generateRoute.POST, {
        method: 'POST',
        token,
        params: { id },
        body: {},
      });
      expect(res.status).toBe(202);
    }

    const freeze = await call(killSwitchRoute.PUT, {
      method: 'PUT',
      token: 'staff',
      body: { level: 'workspace', target: j.org, enabled: true, reason: 'billing dispute' },
    });
    expect(freeze.status).toBe(200);
    const result = await drain(j, { expectClean: false });
    expect(result.failedJobs).toHaveLength(1);

    const frozen = await getProject(j, frozenId);
    expect(frozen.state).toBe('FAILED');
    expect(frozen.errorReason).toContain('kill_switch_workspace');
    const other = await db.videoProject.findUniqueOrThrow({ where: { id: otherId } });
    expect(other.state).toBe('READY_FOR_REVIEW');
    expect(await db.providerJob.count({ where: { organisationId: j.org } })).toBe(0);

    // Released: the frozen org can run again.
    const release = await call(killSwitchRoute.PUT, {
      method: 'PUT',
      token: 'staff',
      body: { level: 'workspace', target: j.org, enabled: false, reason: 'dispute resolved' },
    });
    expect(release.status).toBe(200);
    expect((await generate(j, frozenId)).state).toBe('READY_FOR_REVIEW');
  });

  it('GP-14 analytics are polled after publish and served per publication and overview', async () => {
    const snapshots: MetricSnapshot[] = [
      { views: 120, likes: 10, comments: 2, shares: 1 },
      { views: 900, likes: 80, comments: 9, shares: 5, saves: 3, watchTimeSec: 1200 },
    ];
    const fetcher: MetricsFetcher = {
      platform: 'tiktok',
      fetch: async () => ({
        snapshot: snapshots.shift() ?? { views: 900, likes: 80, comments: 9, shares: 5 },
      }),
    };
    const j = startJourney(db, 'gp14', { metrics: { tiktok: fetcher } });
    j.h.queue.defer.add('poll-publication-analytics');
    const { render } = await approvedTikTokProject(j);
    const conn = await connect(j, 'tiktok', ['video.publish', 'video.list']);
    const pubId = await publish(j, {
      renderId: render.id,
      platform: 'tiktok',
      connectionId: conn.id,
    });
    await drain(j);
    expect(j.h.queue.deferred.map((d) => d.name)).toEqual(['poll-publication-analytics']);

    for (let poll = 0; poll < 2; poll += 1) {
      expect(j.h.queue.release('poll-publication-analytics')).toBe(1);
      await drain(j);
    }
    const detail = await call(analyticsPublicationRoute.GET, {
      token: 'reader',
      params: { id: pubId },
    });
    expect(detail.status).toBe(200);
    expect(detail.json.latest).toMatchObject({ views: 900, likes: 80, watchTimeSec: 1200 });
    const overview = await call(analyticsOverviewRoute.GET, {
      token: 'reader',
      path: '/api/studio/analytics/overview?days=30',
    });
    expect(overview.json).toMatchObject({
      publications: 1,
      totals: { views: 900, likes: 80 },
      byPlatform: { tiktok: { publications: 1, views: 900 } },
    });
    expect(j.h.queue.deferred).toHaveLength(1); // polling continues on schedule
  });

  it('GP-15 a project budget cap stops asset spend before the video provider is called', async () => {
    const j = startJourney(db, 'gp15');
    const id = await createProject(j, briefBody({ costBudgetPence: 10 }));
    const project = await generate(j, id, { expectClean: false });
    expect(project.state).toBe('FAILED');
    expect(project.errorReason).toContain('asset_generation_failed');
    expect(j.h.adapters.runway.requests).toHaveLength(0);
    expect(project.costActualPence).toBeLessThanOrEqual(10);
    const spent = await db.providerJob.aggregate({
      where: { projectId: id },
      _sum: { costPence: true },
    });
    expect(spent._sum.costPence ?? 0).toBeLessThanOrEqual(10);
  });
});
