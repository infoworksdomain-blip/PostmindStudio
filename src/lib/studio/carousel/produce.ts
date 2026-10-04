// Render a stored carousel and keep the slides (21.6): PNG for download, JPEG for publishing,
// both in the renders bucket like every other render. Also the editor's in-memory preview.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { providerOutputKey, type AssetStorage } from '../storage';
import { MAX_SLIDES, SLIDE_HEIGHT, SLIDE_WIDTH } from './constants';
import { libraryImageLoader, loadLogo, type BusinessRef } from './assets';
import type { StoredCarousel } from './document';
import { toDocument } from './document';
import { fontStackFor } from './fonts';
import { prepareCarousel, type PreparedCarousel } from './prepare';
import type { CarouselComposition, CarouselSlideRecord } from './publishing';
import { previewJpeg, renderSlides, type RenderedSlide } from './render';
import type { SlideIssue } from './quality';

type ProduceDb = Pick<PrismaClient, 'imageLibraryItem' | 'videoUpload' | 'brandKit'>;

export interface ProduceDeps {
  readonly db: ProduceDb;
  readonly storage: AssetStorage;
}

export interface Produced {
  readonly prepared: PreparedCarousel;
  readonly slides: readonly RenderedSlide[];
  readonly issues: readonly SlideIssue[];
  readonly aiGenerated: boolean;
}

/** Plan and render every slide of `stored` (at most MAX_SLIDES). */
export async function produceCarousel(
  deps: ProduceDeps,
  scope: BusinessRef,
  stored: StoredCarousel,
): Promise<Produced> {
  const doc = toDocument(stored);
  const fonts = fontStackFor(doc.language);
  const prepared = prepareCarousel(doc, fonts);
  const plans = prepared.plans.slice(0, MAX_SLIDES);
  const images = doc.posts.flatMap((p) => (p.image ? [p.image] : []));
  const slides = await renderSlides({
    plans,
    context: { theme: doc.theme, direction: prepared.direction, profile: prepared.profile },
    fonts,
    loadImage: libraryImageLoader(deps, scope),
    logo: await loadLogo(deps, scope.organisationId, doc.profile.logoUploadId),
    imageSizes: new Map(images.map((i) => [i.imageId, { width: i.width, height: i.height }])),
  });
  const usedIds = new Set(
    plans.flatMap((p) => p.parts.flatMap((part) => part.image?.imageId ?? [])),
  );
  const tooMany: SlideIssue[] =
    prepared.plans.length > MAX_SLIDES
      ? [
          {
            slide: MAX_SLIDES,
            code: 'content_overflow',
            detail: `${prepared.plans.length} slides; at most ${MAX_SLIDES} are rendered`,
          },
        ]
      : [];
  const hookIssue: SlideIssue[] =
    doc.posts[0] && !doc.posts[0].image
      ? [{ slide: 0, code: 'hook_without_image', detail: 'the hook has no picture' }]
      : [];
  return {
    prepared,
    slides,
    issues: [...slides.flatMap((s) => s.issues), ...tooMany, ...hookIssue],
    aiGenerated: images.some((i) => i.aiGenerated && usedIds.has(i.imageId)),
  };
}

/** Issues that fail the quality gate (a missing hook picture is only a warning). */
export function blockingIssues(issues: readonly SlideIssue[]): SlideIssue[] {
  return issues.filter((i) => i.code !== 'hook_without_image');
}

/** The words on a slide, for alt text. */
function altTextOf(slide: RenderedSlide): string {
  return slide.layout.elements
    .flatMap((e) =>
      e.type === 'text' && (e.role === 'body' || e.role === 'bullet') ? [e.text] : [],
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

/** Upload every slide (PNG + JPEG) and describe them as a render composition. */
export async function storeCarousel(
  deps: { storage: AssetStorage; bucket: string },
  scope: { organisationId: string; projectId: string },
  stored: StoredCarousel,
  produced: Produced,
): Promise<CarouselComposition> {
  const run = randomUUID();
  // Same tenant-scoped layout as every other render (storage.ts providerOutputKey).
  const key = (n: string, extension: string): string =>
    providerOutputKey({ ...scope, providerId: 'carousel', extension, id: `${run}-slide-${n}` });
  const records: CarouselSlideRecord[] = [];
  for (const slide of produced.slides) {
    const n = String(slide.index + 1).padStart(2, '0');
    const png = await deps.storage.put({
      bucket: deps.bucket,
      key: key(n, 'png'),
      body: slide.png,
      contentType: 'image/png',
    });
    const jpeg = await deps.storage.put({
      bucket: deps.bucket,
      key: key(n, 'jpg'),
      body: slide.jpeg,
      contentType: 'image/jpeg',
    });
    const plan = produced.prepared.plans[slide.index];
    records.push({
      index: slide.index,
      pngKey: png.key,
      jpegKey: jpeg.key,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      altText: altTextOf(slide),
      postIds: plan ? [...new Set(plan.parts.map((p) => p.postId))] : [],
    });
  }
  return {
    kind: 'carousel',
    version: 1,
    bucket: deps.bucket,
    theme: stored.theme,
    language: stored.language,
    aiGenerated: produced.aiGenerated,
    slides: records,
    issues: produced.issues.map((i) => ({ slide: i.slide, code: i.code, detail: i.detail })),
  };
}

export interface PreviewSlide {
  readonly index: number;
  readonly kind: 'single' | 'pair';
  readonly postIds: readonly string[];
  /** data: URL of a 540 px JPEG. */
  readonly image: string;
}

/** The editor's live preview: the slide breakdown and small JPEGs, nothing stored. */
export async function previewSlides(produced: Produced): Promise<PreviewSlide[]> {
  const out: PreviewSlide[] = [];
  for (const slide of produced.slides) {
    const plan = produced.prepared.plans[slide.index];
    const jpeg = await previewJpeg(slide.png);
    out.push({
      index: slide.index,
      kind: plan?.kind ?? 'single',
      postIds: plan ? [...new Set(plan.parts.map((p) => p.postId))] : [],
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    });
  }
  return out;
}
