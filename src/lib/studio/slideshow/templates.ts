import type { SlideType } from '@prisma/client';
import { z } from 'zod';

// BACKLOG 7.3 / 7.4 — slide types (Addendum A5.3) and the eight built-in templates (A5.4).
// A template's slidePlan is an ordered list of blueprints. A blueprint with `repeat` expands to
// one slide per input item (list entries, images, quotes …) within [min, max].

/** A5.3 typical duration ranges, used to clamp user-set durations. */
export const SLIDE_DURATION_RANGE: Record<SlideType, { min: number; max: number }> = {
  IMAGE_STILL: { min: 1.5, max: 3.0 },
  IMAGE_KENBURNS: { min: 2.5, max: 4.0 },
  VIDEO_CLIP: { min: 1.5, max: 5.0 },
  TEXT_CARD: { min: 1.2, max: 2.5 },
  BEFORE_AFTER: { min: 2.0, max: 4.0 },
  QUOTE: { min: 3.0, max: 5.0 },
  STATISTIC: { min: 2.0, max: 3.5 },
  PRODUCT: { min: 2.5, max: 4.0 },
};

/** Slide types that show a library image (and so need one before rendering). */
export const IMAGE_SLIDE_TYPES: ReadonlySet<SlideType> = new Set<SlideType>([
  'IMAGE_STILL',
  'IMAGE_KENBURNS',
  'PRODUCT',
]);
/** Slide types where an image is an optional background. */
export const OPTIONAL_IMAGE_SLIDE_TYPES: ReadonlySet<SlideType> = new Set<SlideType>([
  'QUOTE',
  'STATISTIC',
]);

export const TRANSITIONS = ['cut', 'fade', 'wipe', 'slide', 'zoom'] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** Which user input a repeating blueprint consumes. */
export const SLIDE_SOURCES = [
  'items', // listicle entries
  'images', // photo dump / explicit image picks
  'quotes',
  'statistics',
  'products',
  'members', // team introduction
] as const;
export type SlideSource = (typeof SLIDE_SOURCES)[number];

export const slideBlueprint = z.object({
  role: z.enum(['hook', 'body', 'cta']),
  slideType: z.enum([
    'IMAGE_STILL',
    'IMAGE_KENBURNS',
    'VIDEO_CLIP',
    'TEXT_CARD',
    'BEFORE_AFTER',
    'QUOTE',
    'STATISTIC',
    'PRODUCT',
  ]),
  durationSec: z.number().min(0.5).max(10),
  transitionIn: z.enum(TRANSITIONS).optional(),
  repeat: z
    .object({
      source: z.enum(SLIDE_SOURCES),
      min: z.number().int().min(1).max(30),
      max: z.number().int().min(1).max(30),
    })
    .refine((r) => r.min <= r.max, { message: 'repeat.min must be ≤ repeat.max' })
    .optional(),
  /** Slide numbers as overlays ("1", "2" …) — listicles. */
  numbered: z.boolean().optional(),
});
export type SlideBlueprint = z.infer<typeof slideBlueprint>;

export const slidePlan = z.array(slideBlueprint).min(1).max(40);

export interface BuiltInTemplate {
  category: string;
  name: string;
  slidePlan: SlideBlueprint[];
  musicMood: string;
  defaultDurationPerSlide: number;
  /** Overlay recipes per role (consumed by the overlay engine, BACKLOG 8.x). */
  overlayDefaults: Record<string, unknown>;
}

const hook = (durationSec = 2): SlideBlueprint => ({
  role: 'hook',
  slideType: 'TEXT_CARD',
  durationSec,
  transitionIn: 'cut',
});
const cta = (durationSec = 2): SlideBlueprint => ({
  role: 'cta',
  slideType: 'TEXT_CARD',
  durationSec,
  transitionIn: 'fade',
});

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    category: 'photo_dump',
    name: 'Photo dump',
    slidePlan: [
      {
        role: 'body',
        slideType: 'IMAGE_STILL',
        durationSec: 2,
        transitionIn: 'fade',
        repeat: { source: 'images', min: 7, max: 15 },
      },
    ],
    musicMood: 'upbeat trending',
    defaultDurationPerSlide: 2,
    overlayDefaults: {},
  },
  {
    category: 'listicle_5',
    name: 'Listicle 5',
    slidePlan: [
      hook(),
      {
        role: 'body',
        slideType: 'IMAGE_STILL',
        durationSec: 2.5,
        transitionIn: 'slide',
        repeat: { source: 'items', min: 5, max: 5 },
        numbered: true,
      },
      cta(),
    ],
    musicMood: 'rhythmic beat',
    defaultDurationPerSlide: 2.5,
    overlayDefaults: { body: { preset: 'listicle_number' } },
  },
  {
    category: 'listicle_10',
    name: 'Listicle 10',
    slidePlan: [
      hook(1.8),
      {
        role: 'body',
        slideType: 'IMAGE_STILL',
        durationSec: 2,
        transitionIn: 'slide',
        repeat: { source: 'items', min: 10, max: 10 },
        numbered: true,
      },
      cta(1.8),
    ],
    musicMood: 'fast tempo',
    defaultDurationPerSlide: 2,
    overlayDefaults: { body: { preset: 'listicle_number' } },
  },
  {
    category: 'before_after',
    name: 'Before/after',
    slidePlan: [
      hook(),
      { role: 'body', slideType: 'BEFORE_AFTER', durationSec: 3.5, transitionIn: 'cut' },
      cta(),
    ],
    musicMood: 'reveal',
    defaultDurationPerSlide: 3,
    overlayDefaults: { body: { preset: 'before_after_labels' } },
  },
  {
    category: 'product_showcase',
    name: 'Product showcase',
    slidePlan: [
      {
        role: 'body',
        slideType: 'PRODUCT',
        durationSec: 3.5,
        transitionIn: 'fade',
        repeat: { source: 'products', min: 1, max: 8 },
      },
      cta(),
    ],
    musicMood: 'confident polished',
    defaultDurationPerSlide: 3.5,
    overlayDefaults: { body: { preset: 'product_callouts' } },
  },
  {
    category: 'quote_reel',
    name: 'Quote reel',
    slidePlan: [
      {
        role: 'body',
        slideType: 'QUOTE',
        durationSec: 4,
        transitionIn: 'fade',
        repeat: { source: 'quotes', min: 3, max: 7 },
      },
    ],
    musicMood: 'ambient lo-fi',
    defaultDurationPerSlide: 4,
    overlayDefaults: { body: { preset: 'quote_card' } },
  },
  {
    category: 'statistic_reel',
    name: 'Statistic reel',
    slidePlan: [
      {
        role: 'body',
        slideType: 'STATISTIC',
        durationSec: 3,
        transitionIn: 'zoom',
        repeat: { source: 'statistics', min: 3, max: 5 },
      },
    ],
    musicMood: 'building intensity',
    defaultDurationPerSlide: 3,
    overlayDefaults: { body: { preset: 'big_number' } },
  },
  {
    category: 'team_introduction',
    name: 'Team introduction',
    slidePlan: [
      {
        role: 'body',
        slideType: 'IMAGE_STILL',
        durationSec: 3,
        transitionIn: 'fade',
        repeat: { source: 'members', min: 1, max: 12 },
      },
      cta(),
    ],
    musicMood: 'warm upbeat',
    defaultDurationPerSlide: 3,
    overlayDefaults: { body: { preset: 'name_and_role' } },
  },
];

export function clampDuration(slideType: SlideType, durationSec: number): number {
  const range = SLIDE_DURATION_RANGE[slideType];
  return Math.min(range.max, Math.max(range.min, Math.round(durationSec * 10) / 10));
}
