// Where a carousel can be published, and what a carousel render stores (21.6).
// A carousel render is one studio.video_renders row (targetPlatform "carousel") whose composition
// lists every slide's PNG (download) and JPEG (publishing: Instagram and TikTok take JPEG only).
import { z } from 'zod';
import { MIN_DURATION_SEC, type Platform, type TargetFormatInput } from '../services/catalog';
import { CAROUSEL_PLATFORM_LIMITS, type CarouselPlatform } from './constants';

export const CAROUSEL_RENDER_PLATFORM = 'carousel';

const slideRecord = z.object({
  index: z.number().int().min(0),
  pngKey: z.string().min(1),
  jpegKey: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  altText: z.string(),
  postIds: z.array(z.string()),
});

export const carouselCompositionSchema = z.object({
  kind: z.literal('carousel'),
  version: z.literal(1),
  bucket: z.string().min(1),
  theme: z.enum(['light', 'dark']),
  language: z.string(),
  aiGenerated: z.boolean(),
  slides: z.array(slideRecord).min(1),
  issues: z.array(z.object({ slide: z.number(), code: z.string(), detail: z.string() })),
});

export type CarouselComposition = z.infer<typeof carouselCompositionSchema>;
export type CarouselSlideRecord = z.infer<typeof slideRecord>;

/** The carousel composition of a render, or null for a video render. */
export function carouselComposition(value: unknown): CarouselComposition | null {
  const parsed = carouselCompositionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Why a platform takes no carousels from Studio (message keys under carousel.publish.unsupported). */
export type CarouselUnsupportedReason = 'reels_video_only' | 'youtube_video_only' | 'x_not_built';

export type CarouselRoute =
  | { readonly supported: true; readonly target: CarouselPlatform }
  | { readonly supported: false; readonly reason: CarouselUnsupportedReason };

/**
 * Each Studio destination → how a carousel goes there. Instagram and Facebook carousels are feed
 * posts (the Reels destinations are video only); LinkedIn's connection posts as linkedin_video;
 * YouTube has no image posts in the Data API; X takes at most 4 images per post and Studio's X
 * publisher uploads video only, so X is not offered (download still works).
 */
export const CAROUSEL_ROUTES: Readonly<Record<Platform, CarouselRoute>> = {
  instagram_feed: { supported: true, target: 'instagram' },
  facebook_feed: { supported: true, target: 'facebook' },
  linkedin_video: { supported: true, target: 'linkedin' },
  tiktok: { supported: true, target: 'tiktok' },
  instagram_reel: { supported: false, reason: 'reels_video_only' },
  facebook: { supported: false, reason: 'reels_video_only' },
  youtube_short: { supported: false, reason: 'youtube_video_only' },
  youtube: { supported: false, reason: 'youtube_video_only' },
  x: { supported: false, reason: 'x_not_built' },
};

/** The destinations a carousel can be published to (one per connected network). */
export const CAROUSEL_PLATFORMS = (Object.keys(CAROUSEL_ROUTES) as Platform[]).filter(
  (p) => CAROUSEL_ROUTES[p].supported,
);

/**
 * The target formats stored on a CAROUSEL project: every network a carousel can go to (captions
 * are written for each; the plan's platform rule counts only where it is published).
 */
export const CAROUSEL_TARGET_FORMATS: TargetFormatInput[] = CAROUSEL_PLATFORMS.map((platform) => ({
  platform,
  aspectRatio: '4:5',
  durationSec: MIN_DURATION_SEC,
}));

/** Human-readable problems publishing `slideCount` slides to `platform` (empty = fine). */
export function carouselPublishProblems(platform: Platform, slideCount: number): string[] {
  const route = CAROUSEL_ROUTES[platform];
  if (!route.supported) return [`${platform} does not take carousels (${route.reason})`];
  const limits = CAROUSEL_PLATFORM_LIMITS[route.target];
  if (slideCount < limits.minItems)
    return [`${route.target} needs at least ${limits.minItems} slides`];
  if (slideCount > limits.maxItems)
    return [
      `${route.target} takes at most ${limits.maxItems} slides (this carousel has ${slideCount})`,
    ];
  return [];
}
