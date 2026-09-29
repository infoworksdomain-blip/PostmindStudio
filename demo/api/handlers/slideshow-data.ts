// Slideshow sample data: the image library the slides draw from, slideshow templates, and the
// slides of each slideshow project (5 bakes to try this weekend), plus slide → shot conversion.
import type {
  Slide,
  SlideContent,
  SlideshowTemplate,
  SlideType,
} from '@/components/studio/slideshow/types';
import { sceneImage, type SceneKind } from '../../media';
import { DEMO_ORG_ID, PROJECTS, SLIDESHOW_TEMPLATES } from '../ids';
import type { ShotContent, Treatment } from './projects-content';

export interface DemoImage {
  id: string;
  kind: SceneKind;
  altText: string;
  tags: string[];
}

/** Image-library ids the slides reference (GET /image-library items use these ids). */
export const DEMO_IMAGES: DemoImage[] = [
  {
    id: 'img-cardamom-bun',
    kind: 'croissant',
    altText: 'Cardamom buns on a tray',
    tags: ['buns', 'cardamom'],
  },
  {
    id: 'img-focaccia',
    kind: 'sourdough',
    altText: 'Wild garlic focaccia',
    tags: ['focaccia', 'spring'],
  },
  {
    id: 'img-country-loaf',
    kind: 'sourdough',
    altText: 'Country sourdough loaf',
    tags: ['sourdough', 'loaf'],
  },
  { id: 'img-lemon-tart', kind: 'cake', altText: 'Lemon tart slice', tags: ['tart', 'lemon'] },
  {
    id: 'img-cinnamon-knot',
    kind: 'croissant',
    altText: 'Cinnamon knots cooling',
    tags: ['cinnamon', 'pastry'],
  },
  { id: 'img-flat-white', kind: 'coffee', altText: 'Flat white on the counter', tags: ['coffee'] },
  {
    id: 'img-shopfront',
    kind: 'storefront',
    altText: 'Leeds Sourdough shopfront',
    tags: ['shop', 'call lane'],
  },
  { id: 'img-bakers', kind: 'baker', altText: 'Bakers shaping dough', tags: ['team', 'bakehouse'] },
  {
    id: 'img-market-stall',
    kind: 'market',
    altText: 'Saturday market stall',
    tags: ['market', 'kirkgate'],
  },
  {
    id: 'img-flatlay',
    kind: 'flatlay',
    altText: 'Weekend bakes flat lay',
    tags: ['flatlay', 'weekend'],
  },
];

// The Business screen's image library (agent "manage"/business) assigns its own ids, so the
// demo's image ids are linked to real library ids once the library has been read.
const realIds = new Map<string, string>();
const demoIds = new Map<string, string>();
export function linkImage(demoId: string, realId: string): void {
  realIds.set(demoId, realId);
  demoIds.set(realId, demoId);
}
/** The id a slide should store for a demo image (the library's id once linked). */
export const libraryId = (demoId: string): string => realIds.get(demoId) ?? demoId;
export const demoImage = (id: string | null): DemoImage | undefined =>
  id ? DEMO_IMAGES.find((i) => i.id === id || i.id === demoIds.get(id)) : undefined;

/** Point every slide at the linked library ids. */
export function relinkSlides(): void {
  for (const [projectId, slides] of slidesByProject)
    slidesByProject.set(
      projectId,
      slides.map((s) => (s.imageAssetId ? { ...s, imageAssetId: libraryId(s.imageAssetId) } : s)),
    );
}

const imageCache = new Map<string, string>();
export function imagePreview(id: string, w = 320, h = 320): string | null {
  const img = DEMO_IMAGES.find((i) => i.id === id);
  if (!img) return null;
  const key = `${id}:${w}x${h}`;
  let url = imageCache.get(key);
  if (!url) {
    url = sceneImage(img.kind, w, h);
    imageCache.set(key, url);
  }
  return url;
}

export function imageLibraryItems(): Array<{
  id: string;
  previewUrl: string | null;
  altText: string;
  tags: string[];
}> {
  return DEMO_IMAGES.map((i) => ({
    id: i.id,
    previewUrl: imagePreview(i.id),
    altText: i.altText,
    tags: i.tags,
  }));
}

// ------------------------------------------------------------------ templates

type Plan = Array<{ slideType: SlideType; role?: 'hook' | 'body' | 'cta'; durationSec: number }>;
const listicle: Plan = [
  { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2.5 },
  ...Array.from({ length: 5 }, () => ({
    slideType: 'IMAGE_KENBURNS' as const,
    role: 'body' as const,
    durationSec: 3,
  })),
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];
const beforeAfter: Plan = [
  { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2 },
  { slideType: 'BEFORE_AFTER', role: 'body', durationSec: 5 },
  { slideType: 'QUOTE', role: 'body', durationSec: 4 },
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];
const photoDump: Plan = Array.from({ length: 8 }, () => ({
  slideType: 'IMAGE_STILL' as const,
  durationSec: 1.5,
}));
const numbered = (n: number): Plan => [
  { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2.5 },
  ...Array.from({ length: n }, () => ({
    slideType: 'IMAGE_KENBURNS' as const,
    role: 'body' as const,
    durationSec: n > 5 ? 2.5 : 3,
  })),
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];
const productShowcase: Plan = [
  { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2 },
  { slideType: 'PRODUCT', role: 'body', durationSec: 3.5 },
  { slideType: 'PRODUCT', role: 'body', durationSec: 3.5 },
  { slideType: 'PRODUCT', role: 'body', durationSec: 3.5 },
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];
const quoteReel: Plan = [
  { slideType: 'QUOTE', role: 'hook', durationSec: 4 },
  { slideType: 'QUOTE', role: 'body', durationSec: 4 },
  { slideType: 'QUOTE', role: 'body', durationSec: 4 },
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];
const statisticReel: Plan = [
  { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2 },
  { slideType: 'STATISTIC', role: 'body', durationSec: 3 },
  { slideType: 'STATISTIC', role: 'body', durationSec: 3 },
  { slideType: 'STATISTIC', role: 'body', durationSec: 3 },
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];
const teamIntro: Plan = [
  { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2.5 },
  { slideType: 'IMAGE_STILL', role: 'body', durationSec: 3.5 },
  { slideType: 'IMAGE_STILL', role: 'body', durationSec: 3.5 },
  { slideType: 'IMAGE_STILL', role: 'body', durationSec: 3.5 },
  { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
];

const templates: SlideshowTemplate[] = [
  {
    id: SLIDESHOW_TEMPLATES.listicle5,
    organisationId: null,
    name: 'Top 5 listicle',
    category: 'listicle',
    slidePlan: listicle,
    musicMood: 'upbeat',
    defaultDurationPerSlide: 3,
  },
  {
    id: SLIDESHOW_TEMPLATES.beforeAfter,
    organisationId: null,
    name: 'Before and after',
    category: 'before_after',
    slidePlan: beforeAfter,
    musicMood: 'uplifting',
    defaultDurationPerSlide: 4,
  },
  {
    id: SLIDESHOW_TEMPLATES.photoDump,
    organisationId: null,
    name: 'Weekend photo dump',
    category: 'photo_dump',
    slidePlan: photoDump,
    musicMood: 'lofi',
    defaultDurationPerSlide: 1.5,
  },
  {
    id: 'sst-org-new-menu',
    organisationId: DEMO_ORG_ID,
    name: 'New menu reveal (ours)',
    category: 'product_launch',
    slidePlan: [
      { slideType: 'TEXT_CARD', role: 'hook', durationSec: 2 },
      { slideType: 'PRODUCT', role: 'body', durationSec: 3.5 },
      { slideType: 'PRODUCT', role: 'body', durationSec: 3.5 },
      { slideType: 'STATISTIC', role: 'body', durationSec: 3 },
      { slideType: 'TEXT_CARD', role: 'cta', durationSec: 2.5 },
    ],
    musicMood: 'warm',
    defaultDurationPerSlide: 3,
  },
  // 17.9: the remaining built-ins of src/lib/studio/slideshow/templates.ts, so the slideshow
  // picker and the Templates screen show every category translated (listicle_5, listicle_10, …).
  builtIn('sst-listicle-5-numbered', 'Listicle 5', 'listicle_5', numbered(5), 'upbeat', 3),
  builtIn('sst-listicle-10', 'Listicle 10', 'listicle_10', numbered(10), 'energetic', 2.5),
  builtIn(
    'sst-product-showcase',
    'Product showcase',
    'product_showcase',
    productShowcase,
    'warm',
    3.5,
  ),
  builtIn('sst-quote-reel', 'Quote reel', 'quote_reel', quoteReel, 'calm', 4),
  builtIn('sst-statistic-reel', 'Statistic reel', 'statistic_reel', statisticReel, 'upbeat', 3),
  builtIn('sst-team-intro', 'Team introduction', 'team_introduction', teamIntro, 'warm', 3.5),
  {
    id: 'sst-org-saved-custom',
    organisationId: DEMO_ORG_ID,
    name: 'Our Friday specials (saved)',
    category: 'custom',
    slidePlan: photoDump.slice(0, 5),
    musicMood: 'lofi',
    defaultDurationPerSlide: 2,
  },
];

function builtIn(
  id: string,
  name: string,
  category: string,
  slidePlan: Plan,
  musicMood: string,
  defaultDurationPerSlide: number,
): SlideshowTemplate {
  return {
    id,
    organisationId: null,
    name,
    category,
    slidePlan,
    musicMood,
    defaultDurationPerSlide,
  };
}

export const listSlideshowTemplates = () => templates.map((t) => ({ ...t }));
export const findSlideshowTemplate = (id: string) => templates.find((t) => t.id === id);
/** 15.E7: remove an organisation template (false when absent). */
export function removeSlideshowTemplate(id: string): boolean {
  const i = templates.findIndex((t) => t.id === id);
  if (i < 0) return false;
  templates.splice(i, 1);
  return true;
}
export function addSlideshowTemplate(t: SlideshowTemplate): SlideshowTemplate {
  templates.push(t);
  return { ...t };
}

// ------------------------------------------------------------------ slides

const IMAGE_TYPES = new Set<SlideType>(['IMAGE_STILL', 'IMAGE_KENBURNS', 'PRODUCT']);

export function slideProblem(
  s: Pick<Slide, 'slideType' | 'imageAssetId' | 'videoAssetId' | 'content'>,
): string | null {
  const m = s.content;
  if (m.pendingText) return 'text not written yet (run auto-populate or edit the slide)';
  if (IMAGE_TYPES.has(s.slideType) && !s.imageAssetId) return 'needs an image';
  switch (s.slideType) {
    case 'VIDEO_CLIP':
      return s.videoAssetId ? null : 'needs a video clip';
    case 'TEXT_CARD':
      return m.text ? null : 'needs text';
    case 'BEFORE_AFTER':
      return m.beforeImageId && m.afterImageId ? null : 'needs before and after images';
    case 'QUOTE':
      return m.quote ? null : 'needs a quote';
    case 'STATISTIC':
      return m.value && m.label ? null : 'needs a value and label';
    case 'PRODUCT':
      return m.name ? null : 'needs a product name';
    default:
      return null;
  }
}

export function makeSlide(
  projectId: string,
  id: string,
  sortOrder: number,
  slideType: SlideType,
  content: SlideContent,
  over: Partial<Slide> = {},
): Slide {
  const base: Slide = {
    imageAssetId: null,
    videoAssetId: null,
    backgroundColor: slideType === 'TEXT_CARD' ? '#1F1A17' : null,
    durationSec: slideType === 'TEXT_CARD' ? 2.5 : 3,
    transitionIn: sortOrder === 0 ? null : 'fade',
    transitionOut: null,
    problem: null,
    ...over,
    id,
    projectId,
    sortOrder,
    slideType,
    content,
  };
  return { ...base, problem: slideProblem(base) };
}

const FIVE = PROJECTS.fiveBakes.id;
const bake = (
  n: number,
  id: string,
  text: string,
  caption: string,
  image: string | null,
  pending = false,
) =>
  makeSlide(
    FIVE,
    id,
    n,
    'IMAGE_KENBURNS',
    pending
      ? { role: 'body', number: n, pendingText: true, imageQuery: caption }
      : { role: 'body', number: n, text, caption },
    { imageAssetId: image },
  );

export const slidesByProject = new Map<string, Slide[]>([
  [
    FIVE,
    [
      makeSlide(FIVE, 'sld-five-hook', 0, 'TEXT_CARD', {
        role: 'hook',
        text: '5 bakes to try this weekend 🥐',
      }),
      bake(1, 'sld-five-1', 'Cardamom buns', 'Swedish-style, knotted by hand', 'img-cardamom-bun'),
      bake(
        2,
        'sld-five-2',
        'Wild garlic focaccia',
        'Only while the wild garlic lasts',
        'img-focaccia',
      ),
      bake(3, 'sld-five-3', 'Lemon tart', 'Sharp, silky, a proper short crust', 'img-lemon-tart'),
      bake(4, 'sld-five-4', 'Cinnamon knots', 'Sticky cinnamon knots', null),
      bake(5, 'sld-five-5', '', 'Country sourdough loaf', 'img-country-loaf', true),
      makeSlide(FIVE, 'sld-five-cta', 6, 'TEXT_CARD', {
        role: 'cta',
        text: 'Call Lane, Leeds · open from 7am',
      }),
    ],
  ],
]);

export function slidesFor(projectId: string): Slide[] {
  return [...(slidesByProject.get(projectId) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Slides drafted from a template for a new slideshow project (auto-populate fills them). */
export function draftSlides(projectId: string, templateId: string, topic: string): Slide[] {
  const plan = (findSlideshowTemplate(templateId)?.slidePlan as Plan | undefined) ?? listicle;
  let n = 0;
  return plan.map((p, i) => {
    const body = p.role === 'body' || !p.role;
    if (body) n += 1;
    const content: SlideContent =
      p.role === 'hook' && topic
        ? { role: 'hook', text: topic.slice(0, 120) }
        : {
            ...(p.role && { role: p.role }),
            ...(body && { number: n }),
            pendingText: true,
            imageQuery: topic,
          };
    return makeSlide(projectId, `sld-${projectId.slice(-6)}-${i}`, i, p.slideType, content, {
      durationSec: p.durationSec,
    });
  });
}

const TREATMENT: Partial<Record<SlideType, Treatment>> = {
  TEXT_CARD: 'TEXT_CARD',
  QUOTE: 'TEXT_CARD',
  STATISTIC: 'MOTION_GRAPHICS',
};

/** The slideshow's shot list (one shot per slide) used when it is generated. */
export function slidesToShots(projectId: string): ShotContent[] {
  return slidesFor(projectId).map((s) => {
    const img = demoImage(s.imageAssetId);
    const text = s.content.text || s.content.quote || s.content.name || s.content.caption || null;
    return {
      scene: img ? `${img.altText}, slow Ken Burns zoom.` : `Text card: ${text ?? 'untitled'}`,
      camera: s.slideType === 'IMAGE_KENBURNS' ? 'Ken Burns push-in' : null,
      voiceover: null,
      onScreen: text,
      treatment: TREATMENT[s.slideType] ?? 'IMAGE_STILL',
      durationSec: s.durationSec,
      kind: img?.kind ?? 'logo',
    };
  });
}
