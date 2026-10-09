// BACKLOG 23.3 (operator decision 2026-10-06, "cheap posts count ¼"): a carousel, a slideshow, a
// wall-of-text video and a hook + demo video each count as ONE QUARTER of a video against the
// plan allowance and against HD video packs; an AI video still counts as 1 and a UGC actor video
// as 2 (ugc/allowance.ts). So Starter's 8 HD videos a month give up to 32 quick posts (Growth 20 →
// 80, Pro 45 → 180; weekly 2 / 5 / 11 videos → 8 / 20 / 44 quick posts a week; yearly per month).
// These posts cost us 3–41p each (measured on production), so a month of 3 posts a day must fit.
//
// DECISION (representation): everything that adds up or stores allowance counts in QUARTERS of a
// video, as integers — a quick post 1, a video 4, a UGC actor video 8; an 8-video allowance is 32
// quarters. No floating point is ever summed or compared, the database keeps integer columns
// (usage_credits.quantityQuarters / remainingQuarters, usage_credit_uses.quarters), and limits
// stay in whole videos where they are configured (catalogue, entitlements, env), converted at the
// edge (videosToQuarters). Customers see videos: quartersToVideos gives 5.5 for 22 quarters (a
// quarter is exact in binary floating point, so the display value is exact too).

/** Quarters in one video of the allowance. */
export const QUARTERS_PER_VIDEO = 4;

/** What one quick post (carousel, slideshow, wall of text, hook + demo) uses: ¼ of a video. */
export const QUICK_POST_QUARTERS = 1;

/** What an ordinary (AI) video uses: one video. */
export const VIDEO_QUARTERS = QUARTERS_PER_VIDEO;

/** The project source types that are quick posts (¼ of a video each). */
export const QUICK_POST_SOURCE_TYPES: readonly string[] = Object.freeze([
  'CAROUSEL',
  'SLIDESHOW',
  'WALL_OF_TEXT',
  'HOOK_DEMO',
]);

export function isQuickPostSourceType(sourceType: string | null | undefined): boolean {
  return typeof sourceType === 'string' && QUICK_POST_SOURCE_TYPES.includes(sourceType);
}

/**
 * Whole (or fractional, from a display value) videos → integer quarters. Rounds to the nearest
 * quarter so a value read back from JSON (5.5) converts exactly.
 */
export function videosToQuarters(videos: number): number {
  return Math.round(videos * QUARTERS_PER_VIDEO);
}

/** Integer quarters → videos for display (22 → 5.5). */
export function quartersToVideos(quarters: number): number {
  return quarters / QUARTERS_PER_VIDEO;
}

/** A limit in videos (null = unlimited) in quarters. */
export function limitInQuarters(videos: number | null): number | null {
  return videos === null ? null : videosToQuarters(videos);
}

/**
 * A month-plan item kind's quarters (content-plans/mix.ts PlanKind): a VIDEO one video, a
 * SLIDESHOW or CAROUSEL a quick post. Pure, so the browser can show the same count.
 */
export function planKindQuarters(kind: string): number {
  return kind === 'VIDEO' ? VIDEO_QUARTERS : QUICK_POST_QUARTERS;
}

/** "5.5" / "8" / "0.25" — plain English for server-side messages and logs (no locale). */
export function formatVideos(quarters: number): string {
  return String(quartersToVideos(quarters));
}
