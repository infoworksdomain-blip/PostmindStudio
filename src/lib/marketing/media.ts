import { marketingSrc } from './media-src';

// Phase 20.8 — every file under public/marketing/ that a page shows, with its pixel size (for the
// img width/height attributes, so nothing shifts while it loads). Photos are Unsplash-licensed
// (public/marketing/SOURCES.md records each one) and only the demo's sample media use them now;
// screens are captured from the demo build by scripts/marketing/capture-screens.mjs; studio/ is
// real PostMind Studio output (made on production on 2026-10-07; the businesses are fictional),
// the posters the landing page shows. test/unit/marketing-media.test.ts checks that each file
// exists with this size, is listed in SOURCES.md and is inlined by the demo shim.

export interface MarketingImage {
  /** Path under public/marketing/. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
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

/** Posters (9:16) of real PostMind Studio output; the hero cards use the 360 px ones. */
export const MARKETING_STUDIO = {
  seedanceBread: { path: 'studio/seedance-bread-720.webp', width: 720, height: 1280 },
  seedanceMarket: { path: 'studio/seedance-market-360.webp', width: 360, height: 640 },
  coastlineStays: { path: 'studio/coastline-stays-slideshow-360.webp', width: 360, height: 640 },
  atelierWren: { path: 'studio/atelier-wren-slideshow-720.webp', width: 720, height: 1280 },
  harbourCoffee: { path: 'studio/harbour-coffee-slideshow-720.webp', width: 720, height: 1280 },
  greenleafFlorist: {
    path: 'studio/greenleaf-florist-slideshow-720.webp',
    width: 720,
    height: 1280,
  },
  pulseStudio: { path: 'studio/pulse-studio-slideshow-720.webp', width: 720, height: 1280 },
} as const satisfies Record<string, MarketingImage>;

/** The product flow the landing page's slides walk through, in order. */
export const FLOW_STEPS = [
  'brief',
  'script',
  'generate',
  'review',
  'calendar',
  'analytics',
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

const SCREEN_SIZE = { width: 1200, height: 750 } as const;

/** One demo screenshot per step, in the light and the dark theme. */
export const FLOW_SCREENS: Record<FlowStep, { light: MarketingImage; dark: MarketingImage }> =
  Object.fromEntries(
    FLOW_STEPS.map((step) => [
      step,
      {
        light: { path: `screens/${step}-light.webp`, ...SCREEN_SIZE },
        dark: { path: `screens/${step}-dark.webp`, ...SCREEN_SIZE },
      },
    ]),
  ) as Record<FlowStep, { light: MarketingImage; dark: MarketingImage }>;

/** Every image the pages use (the test walks this list). */
export const ALL_MARKETING_IMAGES: readonly MarketingImage[] = [
  ...Object.values(MARKETING_PHOTOS),
  ...Object.values(MARKETING_STUDIO),
  ...FLOW_STEPS.flatMap((s) => [FLOW_SCREENS[s].light, FLOW_SCREENS[s].dark]),
];

/** Props for an <img>: src, width and height. */
export function imgProps(image: MarketingImage): { src: string; width: number; height: number } {
  return { src: marketingSrc(image.path), width: image.width, height: image.height };
}
