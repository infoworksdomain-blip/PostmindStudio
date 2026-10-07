import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { StockHit, StockImageSource } from '../../src/lib/studio/images/stock';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { isTooDark } from '../../src/lib/studio/pipeline/edl-backdrop';
import { outputDimensions } from '../../src/lib/studio/pipeline/edl';
import type { BlackInterval } from '../../src/lib/studio/pipeline/media-probe';
import type { AspectRatio } from '../../src/lib/studio/providers/interface';
import { ProviderError } from '../../src/lib/errors';
import { fakePng } from '../helpers/png';
import { BUSINESS_ID, cleanupGolden, createProject, generate, startJourney } from './journey-kit';
import type { Journey } from './journey-kit';

// BACKLOG 20.26 — production 2026-10-03: topic-only slideshows (project
// cmurp3szx001zql068q4fkj0f, "3 Steps to Nail Your Meeting Opener") came out black and failed
// black_frames on every 16:9 and 1:1 output (0–15 s), and one 9:16 reel from 2.5 s; only the
// youtube_short passed. Every slide was a TEXT_CARD with no colour, and the business library
// held one image.
//
// The stub media inspector here does what ffmpeg blackdetect would do with the edit Shotstack
// received: for every 0.1 s it finds the top full-frame visual (an image or video is never
// black; a card is its background colour; nothing = the timeline background) and reports the
// intervals whose colour blackdetect reads as black (luma < 0.2 here, stricter than its 0.10).
// It also reports each render's real frame size, so aspect_ratio is checked per format.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

/** Every platform the operator's slideshows target, covering all four aspect ratios. */
const FORMATS: Array<{ platform: string; aspectRatio: AspectRatio }> = [
  { platform: 'youtube_short', aspectRatio: '9:16' },
  { platform: 'instagram_reel', aspectRatio: '9:16' },
  { platform: 'youtube', aspectRatio: '16:9' },
  { platform: 'linkedin_video', aspectRatio: '16:9' },
  { platform: 'facebook_feed', aspectRatio: '16:9' },
  { platform: 'x', aspectRatio: '1:1' },
  { platform: 'instagram_feed', aspectRatio: '4:5' },
];
const targetFormats = FORMATS.map((f) => ({ ...f, durationSec: 15 }));

const POINTS = [
  'Open with the outcome you want',
  'Name the one decision needed today',
  'Ask a question in the first minute',
  'Keep the opener under 60 seconds',
];
const HOOK = '3 Steps to Nail Your Meeting Opener';
const CTA = 'Follow for more meeting tips';

/** The production slideshow: six text cards, no colours. */
const TEXT_ONLY = [HOOK, ...POINTS, CTA].map((text, i) => ({
  slideType: 'TEXT_CARD',
  durationSec: 2.5,
  transitionIn: 'fade',
  content: { role: i === 0 ? 'hook' : i === POINTS.length + 1 ? 'cta' : 'body', text },
}));

/** What a month plan now creates (content-plan-run.ts): photo slides between hook and CTA. */
const WITH_PHOTOS = [
  { slideType: 'TEXT_CARD', durationSec: 2.5, content: { role: 'hook', text: HOOK } },
  ...POINTS.map((text) => ({
    slideType: 'IMAGE_KENBURNS',
    durationSec: 2.5,
    transitionIn: 'fade',
    kenBurnsSpec: { effect: 'zoomIn' },
    content: { role: 'body', text },
  })),
  { slideType: 'TEXT_CARD', durationSec: 2.5, content: { role: 'cta', text: CTA } },
];

type Asset = { type: string; background?: string; width?: number; height?: number };
type Clip = { asset: Asset; start: number; length: number };
type Edit = {
  timeline: { background: string; tracks: Array<{ clips: Clip[] }> };
  output: { aspectRatio: AspectRatio };
};

/** Pixabay-shaped stock source (storable: copied into our storage, never hotlinked). */
function fakePixabay(): StockImageSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: 'pixabay',
    calls,
    async search(input) {
      calls.push(input.query);
      return [1, 2, 3].map((n): StockHit => ({
        provider: 'pixabay',
        providerImageId: `${encodeURIComponent(input.query)}-${n}`,
        imageUrl: `https://pixabay.example/get/${encodeURIComponent(input.query)}-${n}.png`,
        width: 1280,
        height: 853,
        alt: input.query,
        pageUrl: `https://pixabay.com/photos/${n}/`,
        attribution: { name: 'Pix User', url: 'https://pixabay.com/users/pix-1/' },
        storable: true,
      }));
    },
    async downloadUrl(hit) {
      return hit.imageUrl;
    },
  };
}

let salt = 0;
const imageFetch = (async () =>
  new Response(fakePng(1280, 853, 50_000 + (salt += 1)), {
    headers: { 'content-type': 'image/png' },
  })) as unknown as typeof fetch;

function edits(j: Journey): Edit[] {
  return j.h.adapters.shotstack.requests.map((r) => (r as unknown as { edit: Edit }).edit);
}

/** blackdetect, simulated on the edit (see the header comment). */
function blackIn(edit: Edit, totalSec: number): BlackInterval[] {
  const frame = outputDimensions(edit.output.aspectRatio);
  const visual = edit.timeline.tracks.flatMap((t) =>
    t.clips.filter(
      (c) =>
        ['image', 'video'].includes(c.asset.type) ||
        (c.asset.type === 'html' &&
          c.asset.width === frame.width &&
          c.asset.height === frame.height &&
          c.asset.background),
    ),
  );
  const intervals: BlackInterval[] = [];
  const steps = Math.round(totalSec * 10);
  for (let step = 0; step < steps; step += 1) {
    const t = (step + 0.5) / 10;
    const top = visual.find((c) => c.start <= t && t < c.start + c.length);
    const colour = top
      ? top.asset.type === 'html'
        ? (top.asset.background as string)
        : '#808080'
      : edit.timeline.background;
    if (!isTooDark(colour)) continue;
    const last = intervals.at(-1);
    const startSec = step / 10;
    const endSec = (step + 1) / 10;
    if (last && Math.abs(last.endSec - startSec) < 1e-9) {
      last.endSec = endSec;
      last.durationSec = endSec - last.startSec;
    } else intervals.push({ startSec, endSec, durationSec: endSec - startSec });
  }
  return intervals.filter((i) => i.durationSec >= 0.5);
}

/** Wire the stub media inspector to the render being checked (by its stored key). */
function inspectRenders(j: Journey, totalSec: number) {
  const renderFor = async (url: string) => {
    const renders = await j.db.videoRender.findMany({
      where: { project: { organisationId: j.org } },
    });
    return renders.find((r) => url.includes(r.s3Key));
  };
  vi.mocked(j.h.media.probe).mockImplementation(async (url: string) => {
    // Composition probes its copy before the render row exists (the gate probes it again).
    const render = await renderFor(url);
    const { width, height } = outputDimensions((render?.aspectRatio ?? '9:16') as AspectRatio);
    return {
      durationSec: totalSec,
      width,
      height,
      fps: 30,
      videoCodec: 'h264',
      videoProfile: 'High',
      audioCodec: 'aac',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitRateKbps: 4500,
    };
  });
  vi.mocked(j.h.media.blackIntervals).mockImplementation(async (url: string) => {
    const render = await renderFor(url);
    const edit = edits(j).find((e) => e.output.aspectRatio === render?.aspectRatio);
    if (!edit) throw new Error(`no edit for ${url}`);
    return blackIn(edit, totalSec);
  });
}

async function expectAllFormatsReady(j: Journey, projectId: string) {
  const project = await generate(j, projectId, { expectClean: false });
  const renders = await j.db.videoRender.findMany({ where: { projectId } });
  if (project.state !== 'READY_FOR_REVIEW') {
    throw new Error(
      `${project.state}: ${project.errorReason} ${JSON.stringify([
        renders.map((r) => [r.targetPlatform, r.qualityIssues]),
        j.h.queue.failed,
      ])}`,
    );
  }
  expect(renders.map((r) => r.targetPlatform).sort()).toEqual(
    FORMATS.map((f) => f.platform).sort(),
  );
  for (const render of renders) {
    expect(render.qualityCheckState, render.targetPlatform).toBe('PASSED');
  }
  // The inspector really looked at every render, and the edits are never black anywhere.
  expect(vi.mocked(j.h.media.blackIntervals)).toHaveBeenCalledTimes(FORMATS.length);
  for (const edit of edits(j)) {
    expect(isTooDark(edit.timeline.background)).toBe(false);
    expect(blackIn(edit, 15)).toEqual([]);
  }
  return renders;
}

describe.skipIf(!hasDb)(
  'golden: slideshows are never black and get photos (20.26)',
  { timeout: 300_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();

    beforeAll(async () => {
      await db.$connect();
      await seedOverlayPresets(db);
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => {
      setApiDeps(undefined);
      await cleanupGolden(db, since);
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    it('SV-01 the production text-only slideshow passes on 9:16, 16:9, 1:1 and 4:5', async () => {
      const j = startJourney(db, 'sv01');
      inspectRenders(j, 15);
      const id = await createProject(j, {
        name: '3 Steps to Nail Your Meeting Opener',
        businessId: BUSINESS_ID,
        sourceType: 'SLIDESHOW',
        targetFormats,
        costBudgetPence: 5_000, // seven renders
        slideshow: { topic: HOOK, slides: TEXT_ONLY },
      });
      await expectAllFormatsReady(j, id);
      // Every 16:9/1:1/4:5 card draws text at the 9:16 size (the cause of the whole-video black).
      const sizes = new Set(
        edits(j).flatMap((e) =>
          e.timeline.tracks
            .flatMap((t) => t.clips)
            .map((c) => /font-size: (\d+)px/.exec(String((c.asset as { css?: string }).css))?.[1])
            .filter(Boolean),
        ),
      );
      expect(sizes).toEqual(new Set(['96']));
    });

    it('SV-02 empty library → Pixabay stock per point → photo slides with Ken Burns, all formats ready', async () => {
      const pixabay = fakePixabay();
      const j = startJourney(db, 'sv02', { stockSources: [pixabay], pageFetch: imageFetch });
      inspectRenders(j, 15);
      const id = await createProject(j, {
        name: 'Meeting opener with photos',
        businessId: BUSINESS_ID,
        sourceType: 'SLIDESHOW',
        targetFormats,
        costBudgetPence: 5_000, // seven renders
        slideshow: { topic: HOOK, slides: WITH_PHOTOS },
      });
      await expectAllFormatsReady(j, id);

      expect(pixabay.calls).toEqual(POINTS);
      const slides = await db.slideshowSlide.findMany({
        where: { projectId: id },
        orderBy: { sortOrder: 'asc' },
      });
      expect(slides.map((s) => s.slideType)).toEqual([
        'TEXT_CARD',
        ...POINTS.map(() => 'IMAGE_KENBURNS'),
        'TEXT_CARD',
      ]);
      const images = await db.imageLibraryItem.findMany({
        where: { id: { in: slides.flatMap((s) => (s.imageAssetId ? [s.imageAssetId] : [])) } },
      });
      expect(images).toHaveLength(POINTS.length);
      for (const image of images) {
        expect(image.source).toBe('STOCK');
        expect(image.sourceProvider).toBe('pixabay');
        expect(image.s3Key).toBeTruthy(); // copied into our storage, not hotlinked
        expect(image.licenseNotes).toContain('Pixabay Content License');
        expect(image.licenseNotes).toContain('Photo by Pix User');
      }
      // No AI image was needed, and the edits move the photos with Ken Burns.
      expect(
        j.h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image'),
      ).toHaveLength(0);
      const photoClips = edits(j)[0]!.timeline.tracks.flatMap((t) =>
        t.clips.filter((c) => c.asset.type === 'image'),
      );
      expect(photoClips).toHaveLength(POINTS.length);
      expect(photoClips.every((c) => (c as { effect?: string }).effect === 'zoomIn')).toBe(true);
      expect(photoClips.every((c) => (c as { fit?: string }).fit === 'crop')).toBe(true);
    });

    it('SV-03 stock down → AI images within the budget; no image at all → text cards on the backdrop', async () => {
      const failing: StockImageSource = {
        provider: 'pixabay',
        search: async () => {
          throw new ProviderError('pixabay', 'rate_limited', 'HTTP 429', true);
        },
        downloadUrl: async (hit) => hit.imageUrl,
      };
      const j = startJourney(db, 'sv03', { stockSources: [failing], pageFetch: imageFetch });
      inspectRenders(j, 15);
      const withAi = await createProject(j, {
        name: 'Meeting opener, AI images',
        businessId: BUSINESS_ID,
        sourceType: 'SLIDESHOW',
        targetFormats,
        costBudgetPence: 5_000, // seven renders
        slideshow: { topic: HOOK, slides: WITH_PHOTOS },
      });
      await expectAllFormatsReady(j, withAi);
      const generated = await db.slideshowSlide.findMany({
        where: { projectId: withAi, slideType: 'IMAGE_KENBURNS' },
      });
      expect(generated.every((s) => s.imageAssetId)).toBe(true);
      expect(
        j.h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image'),
      ).toHaveLength(POINTS.length);

      // The image provider is now out of credit as well: the points become text cards.
      const k = startJourney(db, 'sv03b', { stockSources: [failing], pageFetch: imageFetch });
      k.h.adapters.openai.respond = (request) => {
        if (request.capability === 'embedding') {
          return {
            state: 'succeeded',
            output: {
              metadata: {
                embeddings: request.input.map(() => Array.from({ length: 1536 }, () => 0.01)),
                costPence: 1,
              },
            },
          };
        }
        return {
          state: 'failed',
          error: { class: 'insufficient_credits', message: 'out of credit', retryable: false },
        };
      };
      inspectRenders(k, 15);
      const textOnly = await createProject(k, {
        name: 'Meeting opener, no images anywhere',
        businessId: BUSINESS_ID,
        sourceType: 'SLIDESHOW',
        targetFormats,
        costBudgetPence: 5_000, // seven renders
        slideshow: { topic: HOOK, slides: WITH_PHOTOS },
      });
      await expectAllFormatsReady(k, textOnly);
      const cards = await db.slideshowSlide.findMany({
        where: { projectId: textOnly },
        orderBy: { sortOrder: 'asc' },
      });
      expect(cards.every((s) => s.slideType === 'TEXT_CARD' && s.backgroundColor === null)).toBe(
        true,
      );
    });
  },
);
