import { roundSec } from './edl-time';

// BACKLOG 22.1 — the "stacked" layout of a hook + demo video: for the hook's length the reaction
// clip fills the top half of the frame and the demo's first seconds the bottom half; then the
// demo continues full frame from where the bottom half left off. Built only from documented
// Shotstack fields (https://shotstack.io/docs/api/, read 2026-10-05):
//   - VideoAsset `crop` (Crop: "Crop the sides of an asset by a relative amount … a scale between
//     0 and 1 … a top crop of 0.25 will crop the top by quarter of the asset");
//   - Clip `fit` "contain" (fit the whole asset inside the viewport, aspect ratio kept) and
//     `position` "top" / "bottom";
//   - VideoAsset `trim` ("The start trim point of the video clip, in seconds … Videos will start
//     from the in trim point"), so the full-frame demo picks up where the bottom half stopped.
// Each half is cropped to exactly the half-frame's aspect ratio, so `contain` fills it edge to edge
// (no bars for blackdetect). UNCONFIRMED until the first live render: Shotstack's documented
// behaviour of crop + contain + position together (each is documented separately).

export interface Crop {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * The crop that turns a source of `sourceAspect` (width ÷ height) into the aspect ratio of half
 * of `frame` (full width, half height): taller sources lose the top and bottom equally, wider
 * ones the sides.
 */
export function halfFrameCrop(
  sourceAspect: number,
  frame: { width: number; height: number },
): Crop {
  const target = frame.width / (frame.height / 2);
  if (!(sourceAspect > 0) || Math.abs(sourceAspect - target) < 0.001)
    return { top: 0, bottom: 0, left: 0, right: 0 };
  if (sourceAspect < target) {
    const each = r4((1 - sourceAspect / target) / 2);
    return { top: each, bottom: each, left: 0, right: 0 };
  }
  const each = r4((1 - target / sourceAspect) / 2);
  return { top: 0, bottom: 0, left: each, right: each };
}

const hasCrop = (c: Crop) => c.top > 0 || c.bottom > 0 || c.left > 0 || c.right > 0;

/** One half of the stacked frame: the clip (muted unless a volume is given) cropped to fit. */
export function halfFrameClip(input: {
  src: string;
  half: 'top' | 'bottom';
  startSec: number;
  lengthSec: number;
  crop: Crop;
  volume: number;
}): Record<string, unknown> {
  return {
    asset: {
      type: 'video',
      src: input.src,
      volume: input.volume,
      ...(hasCrop(input.crop) && { crop: input.crop }),
    },
    start: roundSec(input.startSec),
    length: roundSec(input.lengthSec),
    fit: 'contain',
    position: input.half,
  };
}
