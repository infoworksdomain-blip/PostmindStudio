import sharp from 'sharp';
import { ValidationError } from '../../errors';

// BACKLOG 13.14 — spec 14.5 "upload logo and auto-extract" the brand palette. The logo is
// decoded with sharp, shrunk to at most 64×64, and its opaque pixels are bucketed (5 bits per
// channel). The most common buckets become colours, skipping ones too close to a colour already
// chosen, and near-white (usually the background of the logo) unless nothing else is left.

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
export const MAX_PALETTE = 5;
const SAMPLE_EDGE = 64;
const MIN_DISTANCE = 48;
const NEAR_WHITE = 235;
const OPAQUE = 128;
/** Raster formats accepted (SVG is refused: it is a document, not an image). */
const LOGO_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif', 'avif']);

type Rgb = [number, number, number];

const hex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Dominant colours from RGBA pixels (exported for tests). */
export function paletteFromPixels(rgba: Uint8Array, max = MAX_PALETTE): string[] {
  const buckets = new Map<number, { count: number; sum: Rgb }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < OPAQUE) continue;
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key) ?? { count: 0, sum: [0, 0, 0] as Rgb };
    buckets.set(key, {
      count: bucket.count + 1,
      sum: [bucket.sum[0] + r, bucket.sum[1] + g, bucket.sum[2] + b],
    });
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((bk) => bk.sum.map((c) => c / bk.count) as Rgb);
  const isWhite = (c: Rgb) => Math.min(...c) >= NEAR_WHITE;
  const chosen: Rgb[] = [];
  for (const allowWhite of [false, true]) {
    for (const colour of ranked) {
      if (chosen.length >= max) break;
      if (!allowWhite && isWhite(colour)) continue;
      if (chosen.every((c) => distance(c, colour) >= MIN_DISTANCE)) chosen.push(colour);
    }
    if (chosen.length > 0) break;
  }
  return chosen.map(hex);
}

export async function extractPalette(bytes: Uint8Array): Promise<string[]> {
  if (bytes.byteLength === 0) throw new ValidationError('The logo file is empty');
  if (bytes.byteLength > MAX_LOGO_BYTES) throw new ValidationError('The logo must be at most 5 MB');
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    throw new ValidationError('The logo is not a readable image');
  }
  if (!format || !LOGO_FORMATS.has(format))
    throw new ValidationError('The logo must be a PNG, JPEG, WebP, GIF or AVIF image');
  const pixels = await sharp(bytes, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const palette = paletteFromPixels(new Uint8Array(pixels));
  if (palette.length === 0) throw new ValidationError('The logo has no visible colours');
  return palette;
}
