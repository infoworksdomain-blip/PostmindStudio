import { roundSec } from './edl-time';

// BACKLOG 15.B1 — brand-kit media on the Shotstack timeline (spec 10.1: "Logo asset (uploaded PNG
// with transparency)", watermark, "Intro card and outro card"). Only documented Clip / ImageAsset /
// VideoAsset fields are used (https://shotstack.io/docs/api/#tocs_clip, read 2026-09-28):
//   - `fit: contain` ("fit the entire asset within the viewport while maintaining the original
//     aspect ratio"), `scale` ("scaling images such as logos and watermarks"), `position`
//     (nine named positions), `offset` (relative to the viewport; y is positive upwards, as in
//     overlays/shotstack.ts) and `opacity` (1 opaque … 0 transparent);
//   - cards are ordinary image/video clips with a `fade` transition.
// The logo bug sits top-right and the watermark top-left: the caption band and most overlays
// live in the lower third.

export interface BrandImage {
  src: string;
  /** Pixel size of the uploaded image (recorded at upload completion). */
  width: number;
  height: number;
}

export interface BrandCard {
  src: string;
  kind: 'image' | 'video';
  /** Video length; image cards show for IMAGE_CARD_SEC. */
  durationSec?: number | null;
}

export interface BrandMedia {
  logo?: BrandImage;
  watermark?: BrandImage;
  intro?: BrandCard;
  outro?: BrandCard;
}

export const LOGO_SCALE = 0.12;
export const LOGO_OPACITY = 0.95;
export const WATERMARK_SCALE = 0.16;
export const WATERMARK_OPACITY = 0.6;
/** Inset from the frame edge, as a fraction of the frame (offset units). */
export const BRAND_INSET = 0.03;
export const IMAGE_CARD_SEC = 2.5;
export const MAX_VIDEO_CARD_SEC = 6;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Card length on the timeline. */
export function cardSec(card: BrandCard | undefined): number {
  if (!card) return 0;
  if (card.kind === 'image') return IMAGE_CARD_SEC;
  const d = card.durationSec && card.durationSec > 0 ? card.durationSec : IMAGE_CARD_SEC;
  return roundSec(Math.min(d, MAX_VIDEO_CARD_SEC));
}

/**
 * Where a `fit: contain` image scaled by `scale` lands when placed top-left with the brand inset
 * (pixels of the layout frame). Used by the quality gate to sample the watermark.
 */
export function brandImageRect(
  image: Pick<BrandImage, 'width' | 'height'>,
  frame: { width: number; height: number },
  scale: number,
  corner: 'topLeft' | 'topRight',
): Rect {
  const fitted = Math.min(frame.width / image.width, frame.height / image.height);
  const width = Math.round(image.width * fitted * scale);
  const height = Math.round(image.height * fitted * scale);
  const insetX = Math.round(frame.width * BRAND_INSET);
  const insetY = Math.round(frame.height * BRAND_INSET);
  return {
    x: corner === 'topLeft' ? insetX : frame.width - insetX - width,
    y: insetY,
    width,
    height,
  };
}

function overlayImageClip(
  src: string,
  span: { startSec: number; lengthSec: number },
  corner: 'topLeft' | 'topRight',
  scale: number,
  opacity: number,
): Record<string, unknown> {
  return {
    asset: { type: 'image', src },
    start: roundSec(span.startSec),
    length: roundSec(span.lengthSec),
    fit: 'contain',
    scale,
    position: corner,
    offset: { x: corner === 'topLeft' ? BRAND_INSET : -BRAND_INSET, y: -BRAND_INSET },
    opacity,
  };
}

export function logoClip(logo: BrandImage, span: { startSec: number; lengthSec: number }) {
  return overlayImageClip(logo.src, span, 'topRight', LOGO_SCALE, LOGO_OPACITY);
}

export function watermarkClip(mark: BrandImage, span: { startSec: number; lengthSec: number }) {
  return overlayImageClip(mark.src, span, 'topLeft', WATERMARK_SCALE, WATERMARK_OPACITY);
}

/** An intro or outro card clip on the visual track. */
export function cardClip(card: BrandCard, startSec: number, edge: 'intro' | 'outro') {
  const length = cardSec(card);
  return {
    asset:
      card.kind === 'image' ? { type: 'image', src: card.src } : { type: 'video', src: card.src },
    start: roundSec(startSec),
    length,
    fit: 'contain',
    transition: edge === 'intro' ? { out: 'fade' } : { in: 'fade' },
  };
}
