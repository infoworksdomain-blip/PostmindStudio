import { marketingSrc } from './media-src';

// Phase 20.8 — every file under public/marketing/ that a page shows, with its pixel size (for the
// img width/height attributes, so nothing shifts while it loads). Photos are Unsplash-licensed
// (public/marketing/SOURCES.md records each one); screens are captured from the demo build by
// scripts/marketing/capture-screens.mjs. test/unit/marketing-media.test.ts checks that each file
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
  gym: { path: 'photos/gym.webp', width: 900, height: 598 },
  salonTools: { path: 'photos/salon-tools.webp', width: 900, height: 774 },
} as const satisfies Record<string, MarketingImage>;

export type MarketingPhoto = keyof typeof MARKETING_PHOTOS;

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
  ...FLOW_STEPS.flatMap((s) => [FLOW_SCREENS[s].light, FLOW_SCREENS[s].dark]),
];

/** Props for an <img>: src, width and height. */
export function imgProps(image: MarketingImage): { src: string; width: number; height: number } {
  return { src: marketingSrc(image.path), width: image.width, height: image.height };
}
