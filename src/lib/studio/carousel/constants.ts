// Carousel (post cards) constants, 21.6. Method from the operator-supplied Claude Code skill
// "instagram-thread-carousel" (SKILL.md reviewed by the operator 2026-10-04), reimplemented natively;
// see plans/phase-21-carousels.md.

/** A carousel counts as this many "videos" against the plan allowance (operator 2026-10-04). */
export const CAROUSEL_ALLOWANCE_UNITS = 1;

/** Instagram 4:5 portrait. */
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

/** Everything is drawn inside this safe area (px from each edge). */
export const SAFE_X = 90;
export const SAFE_Y = 100;
export const CONTENT_WIDTH = SLIDE_WIDTH - SAFE_X * 2;
export const SAFE_HEIGHT = SLIDE_HEIGHT - SAFE_Y * 2;

export const AVATAR_SIZE = 80;
export const AVATAR_GAP = 24;
export const NAME_FONT_SIZE = 34;
export const HANDLE_FONT_SIZE = 30;
export const HEADER_HEIGHT = AVATAR_SIZE;
export const HEADER_TO_TEXT = 32;

/** Body text sizes tried largest first; never smaller than the last (the readable minimum). */
export const MIN_BODY_FONT_SIZE = 38;
export const BODY_FONT_SIZES: readonly number[] = [46, 42, MIN_BODY_FONT_SIZE];
export const LINE_HEIGHT_RATIO = 1.4;
export const PARAGRAPH_GAP_RATIO = 0.5;

export const TEXT_TO_IMAGE = 32;
export const IMAGE_MAX_HEIGHT = 640;
export const IMAGE_RADIUS = 28;

/** Two-post slides: gap above and below the divider. */
export const PAIR_GAP = 56;
export const DIVIDER_THICKNESS = 2;

/** Slide rules (the skill's thresholds, in visible characters). */
export const LONG_POST_CHARS = 200;
export const SHORT_POST_CHARS = 150;
export const IMAGE_SLIDE_MAX_LINES = 3;

/** Thread size the user can ask for (hook + body + CTA). */
export const MIN_POSTS = 3;
export const MAX_POSTS = 12;
export const DEFAULT_POSTS = 7;
export const MAX_POST_CHARS = 600;
export const MAX_HANDLE_CHARS = 30;
export const MAX_NAME_CHARS = 50;

export type CarouselTheme = 'light' | 'dark';

export interface ThemeColours {
  readonly background: string;
  readonly text: string;
  readonly handle: string;
  readonly divider: string;
  readonly avatarFallback: string;
}

// Neutral greys (no platform's palette); text/background and handle/background pass WCAG AA
// (checked in quality.test.ts).
export const THEMES: Readonly<Record<CarouselTheme, ThemeColours>> = {
  light: {
    background: '#FFFFFF',
    text: '#111418',
    handle: '#5B6670',
    divider: '#E3E6E8',
    avatarFallback: '#E3E6E8',
  },
  dark: {
    background: '#000000',
    text: '#F2F4F5',
    handle: '#9AA4AE',
    divider: '#2F3336',
    avatarFallback: '#2F3336',
  },
};

/** Platform carousel limits, from the official docs cited in each publisher. */
export const CAROUSEL_PLATFORM_LIMITS = {
  // developers.facebook.com/docs/instagram-platform/content-publishing (Updated Jun 30, 2026,
  // read 2026-10-04): "Carousels are limited to 10 images, videos, or a mix of the two." JPEG only.
  instagram: { maxItems: 10, minItems: 2 },
  // developers.facebook.com/docs/graph-api/reference/page/photos (v26.0, read 2026-10-04):
  // unpublished photos + /feed attached_media; no item limit is stated there, so the only cap is
  // Studio's own MAX_SLIDES (20).
  facebook: { maxItems: 20, minItems: 2 },
  // learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
  // (li-lms-2026-09, last updated 04/30/2026, read 2026-10-04): "minimum of 2 images and maximum
  // of 20 images".
  linkedin: { maxItems: 20, minItems: 2 },
  // developers.tiktok.com/doc/content-posting-api-reference-photo-post (read 2026-10-04):
  // photo_images "up to 35"; JPEG/WebP, max 20 MB, max 1080p (media transfer guide).
  tiktok: { maxItems: 35, minItems: 1 },
} as const;

export type CarouselPlatform = keyof typeof CAROUSEL_PLATFORM_LIMITS;

/** Most slides a carousel can have (Instagram's cap is the tightest). */
export const MAX_SLIDES = 20;
