import sharp, { type Sharp } from 'sharp';
import type { CompositionSummary } from './composition-summary';
import type { MediaInspector } from './media-probe';
import type { WatermarkSample } from './quality-sync';

// BACKLOG 15.B2 — "Watermark visible in required frames": a frame sample at the watermark's rect.
// Frames are taken with the existing ffmpeg frame grab (media-probe.ts frameJpeg) at the start,
// middle and end of the content; each crop is compared with the watermark image composited at
// its opacity over mid-grey, by Pearson correlation of luminance. A watermark carries a fixed
// pattern the background does not, so a visible mark correlates strongly and footage without
// it does not. Heuristic threshold (MIN_CORRELATION) — a pass needs every sample to clear it.

export const MIN_CORRELATION = 0.3;
const SAMPLE_SIZE = 48;

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[i] as number;
    sb += b[i] as number;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va === 0 || vb === 0 ? 0 : cov / Math.sqrt(va * vb);
}

async function greyPixels(input: Sharp): Promise<Uint8Array> {
  const { data } = await input
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}

/** The reference: the watermark over mid-grey at its on-screen opacity. */
export async function watermarkReference(image: Uint8Array, opacity: number): Promise<Uint8Array> {
  const mark = await sharp(image)
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
    .ensureAlpha(1)
    .png()
    .toBuffer();
  const faded = await sharp(mark)
    .composite([
      {
        input: Buffer.from([255, 255, 255, Math.round(255 * opacity)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
  const base = sharp({
    create: { width: SAMPLE_SIZE, height: SAMPLE_SIZE, channels: 3, background: '#808080' },
  }).composite([{ input: faded }]);
  return greyPixels(sharp(await base.png().toBuffer()));
}

export async function sampleWatermark(input: {
  media: Pick<MediaInspector, 'frameJpeg'>;
  renderUrl: string;
  /** Rendered pixel width (the file may be a scaled draft). */
  renderWidth: number;
  summary: CompositionSummary;
  watermarkImage: Uint8Array;
}): Promise<WatermarkSample> {
  const mark = input.summary.brand.watermark;
  if (!mark) return { status: 'unavailable', reason: 'no watermark on the timeline' };
  try {
    const reference = await watermarkReference(input.watermarkImage, mark.opacity);
    const k = input.renderWidth / input.summary.frame.width;
    const span = mark.endSec - mark.startSec;
    const times = [0.15, 0.5, 0.85].map((f) => mark.startSec + span * f);
    const scores: number[] = [];
    for (const at of times) {
      const jpeg = await input.media.frameJpeg(input.renderUrl, at, input.renderWidth);
      const image = sharp(jpeg);
      const meta = await image.metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      const left = Math.max(0, Math.min(width - 1, Math.round(mark.rect.x * k)));
      const top = Math.max(0, Math.min(height - 1, Math.round(mark.rect.y * k)));
      const region = {
        left,
        top,
        width: Math.max(1, Math.min(width - left, Math.round(mark.rect.width * k))),
        height: Math.max(1, Math.min(height - top, Math.round(mark.rect.height * k))),
      };
      const crop = await greyPixels(sharp(jpeg).extract(region));
      scores.push(Math.round(pearson(crop, reference) * 100) / 100);
    }
    return scores.every((s) => s >= MIN_CORRELATION)
      ? { status: 'visible', scores }
      : { status: 'not_visible', scores };
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message.slice(0, 200) };
  }
}
