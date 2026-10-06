// 22.4 — the Blitz screen's data (GET /api/studio/blitz, services/blitz.ts DeckView) and the pure
// swipe helpers, kept out of the components so they can be tested on their own.

export type FormatKey =
  'carousel' | 'slideshow' | 'wall_of_text' | 'hook_demo' | 'ai_video' | 'ugc';
export type SkipReason = 'not_my_style' | 'wrong_topic' | 'too_salesy' | 'seen_it';
export type KeepMode = 'schedule' | 'post_now' | 'edit';

export const SKIP_REASONS: readonly SkipReason[] = [
  'not_my_style',
  'wrong_topic',
  'too_salesy',
  'seen_it',
];
export const KEEP_MODES: readonly KeepMode[] = ['schedule', 'post_now', 'edit'];

export interface BlitzCard {
  id: string;
  format: FormatKey;
  tier: 'premade' | 'preview';
  angle: { id: string; title: string } | null;
  title: string;
  hook: string;
  body: string[];
  cta: string;
  hookType: string | null;
  caption: string | null;
  whyItWorks: string;
  mentionBusiness: boolean;
  slides: string[];
  videoUrl: string | null;
  posterUrl: string | null;
  previewImageUrl: string | null;
  remix: { id: string; title: string; thumbnailUrl: string | null; durationSec: number } | null;
  allowanceUnits: number;
  createdAt: string;
}

export interface BlitzDeck {
  cards: BlitzCard[];
  rendering: number;
  swipesToday: number;
  swipesLeft: number;
  caps: { rendersToday: number; rendersLeftToday: number; premadeAllowed: boolean };
  paused: 'caps' | 'swipe_cap' | null;
}

export type NudgeNotice =
  | { kind: 'fewer_format'; format: FormatKey }
  | { kind: 'fewer_angle'; angleTitle: string }
  | { kind: 'less_salesy' }
  | { kind: 'at_limit' };

export interface DecisionResult {
  suggestionId: string;
  action: 'keep' | 'skip';
  projectId: string | null;
  publish: 'scheduled' | 'posting' | 'awaiting_approval' | 'edit' | 'no_accounts' | null;
  scheduledFor: string | null;
  downloadOnly: string[];
  notice: NudgeNotice | null;
}

/** How far (px) a card must be dragged before letting go keeps or skips it. */
export const SWIPE_THRESHOLD = 110;
/** Degrees of tilt per 100 px of drag (capped). */
export const TILT_PER_100PX = 6;
export const MAX_TILT = 18;

export type Direction = 'ltr' | 'rtl';
export type SwipeOutcome = 'keep' | 'skip' | null;

/**
 * The outcome of a drag of `dx` px. Keep is towards the end of the line (right in LTR, left in
 * RTL — the gesture mirrors with the reading direction), skip towards the start.
 */
export function swipeOutcome(
  dx: number,
  dir: Direction,
  threshold = SWIPE_THRESHOLD,
): SwipeOutcome {
  const forward = dir === 'rtl' ? -dx : dx;
  if (forward >= threshold) return 'keep';
  if (forward <= -threshold) return 'skip';
  return null;
}

/** The card's tilt for a drag of `dx` px (sign follows the drag, so it leans the way it goes). */
export function tiltFor(dx: number): number {
  const tilt = (dx / 100) * TILT_PER_100PX;
  return Math.max(-MAX_TILT, Math.min(MAX_TILT, tilt));
}

/** 0–1: how sure the drag is (drives the stamp's opacity). */
export function swipeProgress(dx: number, threshold = SWIPE_THRESHOLD): number {
  return Math.min(1, Math.abs(dx) / threshold);
}

/** Arrow keys: → keeps in LTR (← in RTL), the other way skips, ↑ edits first. */
export function keyOutcome(key: string, dir: Direction): 'keep' | 'skip' | 'edit' | null {
  if (key === 'ArrowUp') return 'edit';
  if (key === 'ArrowRight') return dir === 'rtl' ? 'skip' : 'keep';
  if (key === 'ArrowLeft') return dir === 'rtl' ? 'keep' : 'skip';
  return null;
}

/** Where the card flies off to when it is kept (+1) or skipped (−1), on screen. */
export function exitSign(outcome: 'keep' | 'skip', dir: Direction): 1 | -1 {
  const forward = outcome === 'keep' ? 1 : -1;
  return (dir === 'rtl' ? -forward : forward) as 1 | -1;
}
