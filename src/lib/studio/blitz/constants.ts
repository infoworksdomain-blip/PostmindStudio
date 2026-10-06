import type { Prisma } from '@prisma/client';

// 22.4 — Blitz limits (operator brief 2026-10-06: "lowest cost"; plans/phase-22-blitz-automations.md).

/** Ready (or rendering) suggestions kept per business (Fastlane keeps about 5). */
export const BLITZ_QUEUE_SIZE = 5;
/** Pre-made renders (carousels, slideshows) per business per UTC day. */
export const BLITZ_DAILY_RENDER_CAP = 20;
/**
 * Pre-made render spend per business per calendar month, in pence, from the existing cost
 * tracking (video_projects.costActualPence of Blitz render projects). A slideshow costs a few
 * pence on Shotstack; a carousel is free (our renderer) apart from the copy call.
 */
export const BLITZ_MONTHLY_RENDER_CAP_PENCE = 300;
/** Swipes (keep or skip) per person per UTC day. */
export const BLITZ_DAILY_SWIPES = 60;
/** At most this many suggestions are written in one refill (one Claude call). */
export const BLITZ_REFILL_BATCH = BLITZ_QUEUE_SIZE;
/** Refills are debounced: one job per business per this many ms. */
export const BLITZ_REFILL_DEBOUNCE_MS = 30_000;
/** A card nobody swiped is retired after this long (its render project is archived). */
export const BLITZ_SUGGESTION_TTL_DAYS = 14;
/** Most angles per business (Fastlane: 100 per workspace). */
export const MAX_ANGLES = 100;

/**
 * metadata.blitz on a render project: `pending` while the card waits for a swipe (not counted
 * against the allowance, hidden from the projects list, no "ready for review" notifications),
 * `kept` once it is kept (counted from then on, like any project).
 */
export interface BlitzProjectMeta {
  suggestionId: string;
  state: 'pending' | 'kept' | 'skipped';
}

export function blitzMetaOf(
  metadata: Prisma.JsonValue | null | undefined,
): BlitzProjectMeta | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).blitz;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.suggestionId !== 'string') return null;
  if (b.state !== 'pending' && b.state !== 'kept' && b.state !== 'skipped') return null;
  return { suggestionId: b.suggestionId, state: b.state };
}

/** A Blitz render nobody has kept yet: not counted, not listed, not notified. */
export function isUnkeptBlitz(metadata: Prisma.JsonValue | null | undefined): boolean {
  const meta = blitzMetaOf(metadata);
  return meta !== null && meta.state !== 'kept';
}
