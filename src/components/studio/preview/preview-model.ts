import type { PreviewMedia } from '@/lib/studio/services/post-preview-media';
import type { PreviewAspect } from '@/lib/studio/services/post-preview';

// BACKLOG 24.2 — the instant preview's timeline, kept pure so it is tested without Remotion:
// composition size per target aspect ratio (the same 1080-wide frames the renders use) and how
// many frames each slide / shot / text block / render gets.

export const PREVIEW_FPS = 30;
/** A text block or a slide without a duration is shown this long. */
export const DEFAULT_SEGMENT_SEC = 3;
/** Never a zero-length composition (the Player requires durationInFrames > 0). */
export const MIN_PREVIEW_SEC = 1;
/** Longer previews are cut here (a storyboard or render longer than a short is unusual). */
export const MAX_PREVIEW_SEC = 180;

export const ASPECT_SIZE: Readonly<Record<PreviewAspect, { width: number; height: number }>> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
};

export function framesFor(seconds: number, fps = PREVIEW_FPS): number {
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SEGMENT_SEC;
  return Math.max(1, Math.round(sec * fps));
}

/** Frames per segment, in order (slides, shots, the text block or the whole render). */
export function segmentFrames(media: PreviewMedia, fps = PREVIEW_FPS): number[] {
  switch (media.kind) {
    case 'video':
      return [framesFor(media.durationSec, fps)];
    case 'text':
      return [framesFor(media.durationSec, fps)];
    case 'slides':
      return media.slides.map((s) => framesFor(s.durationSec, fps));
    case 'storyboard':
      return media.shots.map((s) => framesFor(s.durationSec, fps));
    case 'none':
      return [];
  }
}

/** The Player's durationInFrames: the segments' sum, within [MIN, MAX] seconds. */
export function totalFrames(media: PreviewMedia, fps = PREVIEW_FPS): number {
  const sum = segmentFrames(media, fps).reduce((a, b) => a + b, 0);
  return Math.min(MAX_PREVIEW_SEC * fps, Math.max(MIN_PREVIEW_SEC * fps, sum));
}

/** Whether the preview has anything to play. */
export function hasPreview(media: PreviewMedia): boolean {
  return media.kind !== 'none';
}
