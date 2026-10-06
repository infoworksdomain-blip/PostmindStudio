import type { Logger } from 'pino';
import type { Crop } from './edl-stacked';
import type { MediaInspector } from './media-probe';

// BACKLOG 22.6 (production QA 2026-10-06) — black bars baked into a clip. A Veo text-to-video hook
// (720×1280) came back with a ~10 % black band across the top, and the final video showed a black
// bar behind the AI label and the hook text. Every stored VIDEO_CLIP is checked once with ffmpeg
// `cropdetect` and the bars are recorded on the asset (metadata.letterbox); the composer then crops
// them off with Shotstack's clip `crop` while `fit: crop` fills the frame (pipeline/edl.ts).
//
// ffmpeg-filters "cropdetect" (https://ffmpeg.org/ffmpeg-filters.html#cropdetect, read 2026-10-06):
// "Detect black pixels surrounding the playing video"; `limit` is the "higher black value
// threshold … from nothing (0) to everything (255 for 8-bit based formats). An intensity value
// greater to the set value is considered non-black. It defaults to 24"; `round` (default 16) is
// what width/height are made divisible by; `skip` is "the number of initial frames for which
// evaluation is skipped" (default 2). The filter logs one line per frame:
//   "[Parsed_cropdetect_1 @ 0x…] x1:0 x2:719 y1:128 y2:1279 w:720 h:1152 x:0 y:128 pts:… t:… crop=…"
// With the default reset (never), x1/x2/y1/y2 widen over the frames seen, so the last line is the
// picture area across every sampled frame: a bar is only reported where every sample is black.
// We read x1..y2 (the detected edges), not w/h/x/y (rounded to `round` and re-centred).

/** Bars thinner than this (fraction of the side) are left alone. */
export const LETTERBOX_MIN_FRACTION = 0.02;
/** More than this on one side is not a letterbox but a dark picture: detection is ignored. */
export const LETTERBOX_MAX_FRACTION = 0.3;
/** Extra trimmed past a detected bar, so a soft or anti-aliased edge does not leave a dark line. */
export const LETTERBOX_EDGE_MARGIN = 0.005;
/** Frames sampled per second, and how much of the clip is read (a few frames are enough). */
export const LETTERBOX_SAMPLE_FPS = 2;
export const LETTERBOX_MAX_SEC = 12;
/** cropdetect's black threshold, pinned at the documented default (0–255 scale). */
export const CROPDETECT_LIMIT = 24;

export interface CropBounds {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export const NO_CROP: Crop = { top: 0, bottom: 0, left: 0, right: 0 };

/** The -vf argument: a few frames a second through cropdetect, every frame evaluated. */
export function cropdetectFilter(): string {
  return `fps=${LETTERBOX_SAMPLE_FPS},cropdetect=limit=${CROPDETECT_LIMIT}:round=2:skip=0`;
}

const CROP_LINE = /x1:\s*(-?\d+)\s+x2:\s*(-?\d+)\s+y1:\s*(-?\d+)\s+y2:\s*(-?\d+)/g;

/** The last cropdetect line's edges (the area across all frames seen), or null when none. */
export function parseCropdetect(stderr: string): CropBounds | null {
  let last: CropBounds | null = null;
  for (const m of stderr.matchAll(CROP_LINE)) {
    last = { x1: Number(m[1]), x2: Number(m[2]), y1: Number(m[3]), y2: Number(m[4]) };
  }
  return last;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

function side(px: number, size: number): number {
  const fraction = px / size;
  if (!(fraction >= LETTERBOX_MIN_FRACTION)) return 0;
  return r4(Math.min(1, fraction + LETTERBOX_EDGE_MARGIN));
}

/**
 * The bars as fractions of the frame (Shotstack Crop is relative, 0–1). Bars under 2 % count as
 * none; an all-black sample (x2 < x1) or a "bar" over 30 % (a dark scene, not a letterbox) gives
 * null, meaning "do not crop".
 */
export function letterboxFromBounds(
  bounds: CropBounds,
  frame: { width: number; height: number },
): Crop | null {
  const { width, height } = frame;
  if (!(width > 0 && height > 0)) return null;
  if (bounds.x2 < bounds.x1 || bounds.y2 < bounds.y1) return null;
  const raw = {
    top: Math.max(0, bounds.y1),
    bottom: Math.max(0, height - 1 - bounds.y2),
    left: Math.max(0, bounds.x1),
    right: Math.max(0, width - 1 - bounds.x2),
  };
  if (
    raw.top / height > LETTERBOX_MAX_FRACTION ||
    raw.bottom / height > LETTERBOX_MAX_FRACTION ||
    raw.left / width > LETTERBOX_MAX_FRACTION ||
    raw.right / width > LETTERBOX_MAX_FRACTION
  )
    return null;
  return {
    top: side(raw.top, height),
    bottom: side(raw.bottom, height),
    left: side(raw.left, width),
    right: side(raw.right, width),
  };
}

export const hasBars = (c: Crop | null | undefined): c is Crop =>
  Boolean(c && (c.top > 0 || c.bottom > 0 || c.left > 0 || c.right > 0));

/** The bars recorded on an asset (metadata.letterbox), or null when none / never measured. */
export function letterboxOf(metadata: unknown): Crop | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const lb = (metadata as Record<string, unknown>).letterbox;
  if (!lb || typeof lb !== 'object') return null;
  const v = lb as Record<string, unknown>;
  const num = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 0.5 ? x : 0;
  const crop = { top: num(v.top), bottom: num(v.bottom), left: num(v.left), right: num(v.right) };
  return hasBars(crop) ? crop : null;
}

/** Whether the asset was already measured (metadata.letterbox present, bars or not). */
export function letterboxMeasured(metadata: unknown): boolean {
  return Boolean(metadata && typeof metadata === 'object' && 'letterbox' in (metadata as object));
}

/**
 * `inner` is relative to the picture left after `bars` are cut off; the result is the single crop
 * of the whole source that does both (the stacked layout's half-frame crop over a letterboxed clip).
 */
export function combineCrop(bars: Crop | null, inner: Crop): Crop {
  if (!hasBars(bars)) return inner;
  const h = 1 - bars.top - bars.bottom;
  const w = 1 - bars.left - bars.right;
  return {
    top: r4(bars.top + inner.top * h),
    bottom: r4(bars.bottom + inner.bottom * h),
    left: r4(bars.left + inner.left * w),
    right: r4(bars.right + inner.right * w),
  };
}

/** Width ÷ height of what is left once the bars are cut off. */
export function visibleAspect(aspect: number, bars: Crop | null): number {
  if (!hasBars(bars)) return aspect;
  return (aspect * (1 - bars.left - bars.right)) / (1 - bars.top - bars.bottom);
}

/**
 * Measure a stored clip's bars. Never throws: a detection error (no ffmpeg, an unreadable file,
 * a build without cropdetect) is logged and gives undefined, so the shot is stored uncropped.
 * Returns NO_CROP when the clip was measured and has no bars.
 */
export async function detectLetterbox(
  media: MediaInspector,
  /** The clip's (signed) URL; resolved inside the guard so a signing error is not fatal either. */
  url: () => Promise<string>,
  log: Pick<Logger, 'warn'>,
  context: Record<string, unknown> = {},
): Promise<Crop | undefined> {
  if (!media.cropBounds) return undefined;
  try {
    const found = await media.cropBounds(await url(), LETTERBOX_MAX_SEC);
    if (!found) return NO_CROP;
    return letterboxFromBounds(found.bounds, found.frame) ?? NO_CROP;
  } catch (err) {
    log.warn(
      { ...context, err: err instanceof Error ? err.message : String(err) },
      'black-bar detection failed; the clip is used uncropped',
    );
    return undefined;
  }
}
