import { marketingSrc } from './media-src';

// Every file under public/marketing/ that a page shows, with its pixel size (for the img and video
// width/height attributes, so nothing shifts while it loads). test/unit/marketing-media.test.ts
// checks that each file exists at this size, is listed in public/marketing/SOURCES.md and is
// inlined (or deliberately left out) by the demo shim.
//
//   photos/   Unsplash-licensed stills (Phase 20.8); since 25.5 only the demo's sample thumbnails
//             and canvas videos use them (demo/media.ts).
//   screens/  product screenshots captured from the demo build (scripts/marketing/capture-screens.mjs).
//   studio/   25.5: real PostMind Studio output made on production on 2026-10-07 (showcase
//             businesses are fictional): AI video clips and slideshow / wall-of-text loops, each
//             with a 360 px and a 720 px WebP poster and a JPEG fallback
//             (scripts/marketing/encode-studio-media.mjs).

export interface MarketingImage {
  /** Path under public/marketing/. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

export interface MarketingVideo extends MarketingImage {
  readonly type: 'video/mp4';
}

export const MARKETING_PHOTOS = {
  sourdoughLoaf: { path: 'photos/sourdough-loaf.webp', width: 601, height: 900 },
  sourdoughHands: { path: 'photos/sourdough-hands.webp', width: 601, height: 900 },
  sourdoughBoard: { path: 'photos/sourdough-board.webp', width: 900, height: 600 },
  marketStall: { path: 'photos/market-stall.webp', width: 780, height: 900 },
  doughKneading: { path: 'photos/dough-kneading.webp', width: 900, height: 600 },
  croissants: { path: 'photos/croissants.webp', width: 601, height: 900 },
  coffee: { path: 'photos/coffee.webp', width: 720, height: 900 },
  cake: { path: 'photos/cake.webp', width: 900, height: 600 },
  doughBalls: { path: 'photos/dough-balls.webp', width: 600, height: 900 },
  breakfast: { path: 'photos/breakfast.webp', width: 600, height: 900 },
} as const satisfies Record<string, MarketingImage>;

export type MarketingPhoto = keyof typeof MARKETING_PHOTOS;

/** The product screens the landing page shows, each in the light and the dark theme. */
export const PRODUCT_SCREEN_NAMES = ['script', 'generate', 'calendar', 'analytics'] as const;
export type ProductScreen = (typeof PRODUCT_SCREEN_NAMES)[number];

const SCREEN_SIZE = { width: 1200, height: 750 } as const;

export const PRODUCT_SCREENS: Record<
  ProductScreen,
  { light: MarketingImage; dark: MarketingImage }
> = Object.fromEntries(
  PRODUCT_SCREEN_NAMES.map((name) => [
    name,
    {
      light: { path: `screens/${name}-light.webp`, ...SCREEN_SIZE },
      dark: { path: `screens/${name}-dark.webp`, ...SCREEN_SIZE },
    },
  ]),
) as Record<ProductScreen, { light: MarketingImage; dark: MarketingImage }>;

/** A Studio-made clip: posters for the <picture> and the muted loop. All are 9:16. */
export interface StudioClip {
  readonly id: string;
  readonly poster: {
    /** 360×640 WebP. */
    readonly small: MarketingImage;
    /** 720×1280 WebP. */
    readonly large: MarketingImage;
    /** 540×960 JPEG for browsers without WebP. */
    readonly fallback: MarketingImage;
  };
  readonly video: MarketingVideo;
}

function clip(id: string, video: { width: number; height: number }): StudioClip {
  return {
    id,
    poster: {
      small: { path: `studio/${id}-360.webp`, width: 360, height: 640 },
      large: { path: `studio/${id}-720.webp`, width: 720, height: 1280 },
      fallback: { path: `studio/${id}.jpg`, width: 540, height: 960 },
    },
    video: { path: `studio/${id}.mp4`, type: 'video/mp4', ...video },
  };
}

/** Seedance clips are 720×1280; the renderer's loops are the first 6 s at 540×960. */
const AI_VIDEO = { width: 720, height: 1280 } as const;
const LOOP = { width: 540, height: 960 } as const;

export const STUDIO_CLIPS = {
  seedanceBread: clip('seedance-bread', AI_VIDEO),
  seedanceMarket: clip('seedance-market', AI_VIDEO),
  northsideBakery: clip('northside-bakery-slideshow', LOOP),
  atelierWren: clip('atelier-wren-slideshow', LOOP),
  pulseStudio: clip('pulse-studio-slideshow', LOOP),
  coastlineStays: clip('coastline-stays-slideshow', LOOP),
  greenleafFlorist: clip('greenleaf-florist-slideshow', LOOP),
  harbourCoffee: clip('harbour-coffee-slideshow', LOOP),
  pulseStudioText: clip('pulse-studio-wall-of-text', LOOP),
  coastlineStaysText: clip('coastline-stays-wall-of-text', LOOP),
} as const satisfies Record<string, StudioClip>;

export type StudioClipName = keyof typeof STUDIO_CLIPS;

/** Every image the pages use (the test walks this list). */
export const ALL_MARKETING_IMAGES: readonly MarketingImage[] = [
  ...Object.values(MARKETING_PHOTOS),
  ...PRODUCT_SCREEN_NAMES.flatMap((s) => [PRODUCT_SCREENS[s].light, PRODUCT_SCREENS[s].dark]),
  ...Object.values(STUDIO_CLIPS).flatMap((c) => [
    c.poster.small,
    c.poster.large,
    c.poster.fallback,
  ]),
];

/** Every video the pages use. */
export const ALL_MARKETING_VIDEOS: readonly MarketingVideo[] = Object.values(STUDIO_CLIPS).map(
  (c) => c.video,
);

/** Props for an <img>: src, width and height. */
export function imgProps(image: MarketingImage): { src: string; width: number; height: number } {
  return { src: marketingSrc(image.path), width: image.width, height: image.height };
}
