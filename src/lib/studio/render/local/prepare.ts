import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import sharp, { type Sharp } from 'sharp';
import { UpstreamServiceError } from '../../../errors';
import type { PreparedBase, PreparedLayer, PreparedTimeline } from './ffmpeg-args';
import type { Rgba } from './edit-json';
import { placeIn, renderTextCard } from './text-image';
import type { BaseClip, Fit, LayerClip, LocalTimeline, Placement } from './timeline';

// BACKLOG 23.5 — everything a local render reads, in its private temp directory: each source URL
// downloaded once (images, background video, music), pictures resized with sharp to exactly what
// ffmpeg draws (Shotstack `fit`: crop = fill keeping the aspect ratio and centre-crop, cover =
// stretch, contain = fit inside on the backdrop, none = natural size), text cards drawn as PNGs
// (text-image.ts), and layer positions worked out from Shotstack `position` + `offset`.

/** Ken Burns stills are drawn from a picture this much larger than the frame (less zoompan jitter). */
export const KEN_BURNS_SUPERSAMPLE = 1.5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const JPEG_QUALITY = 92;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
};

export interface PrepareContext {
  readonly dir: string;
  readonly fetch: typeof fetch;
  readonly fontsDir?: string;
}

class Downloads {
  private readonly files = new Map<string, Promise<string>>();
  private count = 0;

  constructor(private readonly ctx: PrepareContext) {}

  /** The local file for a URL (downloaded once, streamed to disk). */
  file(url: string): Promise<string> {
    const known = this.files.get(url);
    if (known) return known;
    const name = `in-${(this.count += 1)}`;
    const pending = this.download(url, name);
    this.files.set(url, pending);
    return pending;
  }

  async bytes(url: string): Promise<Buffer> {
    return readFile(path.join(this.ctx.dir, await this.file(url)));
  }

  private async download(url: string, name: string): Promise<string> {
    const res = await this.ctx.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new UpstreamServiceError(`local render input could not be downloaded (${res.status})`);
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const file = `${name}${EXTENSIONS[type] ?? '.media'}`;
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(path.join(this.ctx.dir, file)),
    );
    return file;
  }
}

function sharpBackground(c: Rgba) {
  return { r: c.r, g: c.g, b: c.b, alpha: c.a };
}

/** Top-left of a w×h item at a clip's position + offset (offset y is positive upwards). */
export function placeOnFrame(
  placement: Placement,
  item: { width: number; height: number },
  frame: { width: number; height: number },
): { x: number; y: number } {
  const at = placeIn(placement.position, item, frame);
  return {
    x: Math.round(at.x + placement.offsetX * frame.width),
    y: Math.round(at.y - placement.offsetY * frame.height),
  };
}

/** A picture resized for a Shotstack `fit` into a w×h area (RGBA PNG unless `flatten`). */
async function fitPicture(
  bytes: Buffer,
  fit: Fit,
  area: { width: number; height: number },
  background: Rgba,
): Promise<Sharp> {
  const img = sharp(bytes).rotate();
  switch (fit) {
    case 'crop':
      return img.resize(area.width, area.height, { fit: 'cover', position: 'centre' });
    case 'cover':
      return img.resize(area.width, area.height, { fit: 'fill' });
    case 'contain':
      return img.resize(area.width, area.height, {
        fit: 'contain',
        background: sharpBackground(background),
      });
    case 'none': {
      const canvas = sharp({
        create: { ...area, channels: 4, background: sharpBackground(background) },
      });
      const own = await img.png().toBuffer({ resolveWithObject: true });
      const left = Math.round((area.width - own.info.width) / 2);
      const top = Math.round((area.height - own.info.height) / 2);
      const piece =
        left < 0 || top < 0
          ? await sharp(own.data)
              .extract({
                left: Math.max(0, -left),
                top: Math.max(0, -top),
                width: Math.min(own.info.width, area.width),
                height: Math.min(own.info.height, area.height),
              })
              .toBuffer()
          : own.data;
      return canvas.composite([{ input: piece, left: Math.max(0, left), top: Math.max(0, top) }]);
    }
  }
}

async function prepareBase(
  clip: BaseClip,
  index: number,
  timeline: LocalTimeline,
  downloads: Downloads,
  ctx: PrepareContext,
  notes: string[],
): Promise<PreparedBase> {
  const { frame, backdrop } = timeline;
  const source = clip.source;
  const flat = { r: backdrop.r, g: backdrop.g, b: backdrop.b, alpha: 1 };
  if (source.kind === 'video') {
    if (source.fit !== 'crop' && source.fit !== 'contain')
      notes.push(`video fit ${source.fit} drawn as crop`);
    return {
      kind: 'video',
      file: await downloads.file(source.src),
      fit: source.fit === 'contain' ? 'contain' : 'cover',
      trimSec: source.trimSec,
      crop: source.crop,
    };
  }
  if (source.kind === 'image' && source.kenBurns) {
    const file = `kb-${index}.jpg`;
    const area = {
      width: Math.round(frame.width * KEN_BURNS_SUPERSAMPLE),
      height: Math.round(frame.height * KEN_BURNS_SUPERSAMPLE),
    };
    const img = await fitPicture(await downloads.bytes(source.src), source.fit, area, backdrop);
    await img
      .flatten({ background: flat })
      .jpeg({ quality: JPEG_QUALITY })
      .toFile(path.join(ctx.dir, file));
    return { kind: 'kenBurns', file, kenBurns: source.kenBurns };
  }
  if (source.kind === 'image') {
    const file = `still-${index}.jpg`;
    const img = await fitPicture(await downloads.bytes(source.src), source.fit, frame, backdrop);
    await img
      .flatten({ background: flat })
      .jpeg({ quality: JPEG_QUALITY })
      .toFile(path.join(ctx.dir, file));
    return { kind: 'still', file };
  }
  // A text card on the bottom track: drawn on the backdrop at its position.
  const card = await renderTextCard(source.card, ctx.fontsDir);
  notes.push(...card.notes);
  const at = placeOnFrame(clip, card, frame);
  const file = `card-${index}.png`;
  await sharp({
    create: { width: frame.width, height: frame.height, channels: 4, background: flat },
  })
    .composite([
      {
        input: await clipToFrame(card.png, at, card, frame),
        left: Math.max(0, at.x),
        top: Math.max(0, at.y),
      },
    ])
    .flatten({ background: flat })
    .png()
    .toFile(path.join(ctx.dir, file));
  return { kind: 'still', file };
}

/** The part of a w×h picture at (x, y) that lies inside the frame. */
async function clipToFrame(
  png: Buffer,
  at: { x: number; y: number },
  size: { width: number; height: number },
  frame: { width: number; height: number },
): Promise<Buffer> {
  const left = Math.max(0, -at.x);
  const top = Math.max(0, -at.y);
  const width = Math.min(size.width, frame.width - at.x) - left;
  const height = Math.min(size.height, frame.height - at.y) - top;
  if (left === 0 && top === 0 && width === size.width && height === size.height) return png;
  if (width <= 0 || height <= 0) {
    return sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }
  return sharp(png).extract({ left, top, width, height }).png().toBuffer();
}

/** Multiply a PNG's alpha by `opacity` (0–1). */
export async function withOpacity(png: Buffer, opacity: number): Promise<Buffer> {
  if (opacity >= 1) return png;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round((data[i] ?? 0) * opacity);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

async function layerPicture(
  clip: LayerClip,
  downloads: Downloads,
  timeline: LocalTimeline,
  ctx: PrepareContext,
  notes: string[],
): Promise<{ png: Buffer; width: number; height: number }> {
  const { frame } = timeline;
  const source = clip.source;
  if (source.kind === 'text') {
    const card = await renderTextCard(source.card, ctx.fontsDir);
    notes.push(...card.notes);
    return card;
  }
  if (source.kind !== 'image') throw new UpstreamServiceError('video layer handled elsewhere');
  const bytes = await downloads.bytes(source.src);
  const meta = await sharp(bytes).rotate().toBuffer({ resolveWithObject: true });
  const natural = { width: meta.info.width, height: meta.info.height };
  const scale = clip.scale ?? 1;
  let size: { width: number; height: number };
  if (source.fit === 'contain') {
    const k = Math.min(frame.width / natural.width, frame.height / natural.height) * scale;
    size = { width: natural.width * k, height: natural.height * k };
  } else if (source.fit === 'none') {
    size = { width: natural.width * scale, height: natural.height * scale };
  } else {
    size = { width: frame.width * scale, height: frame.height * scale };
  }
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const png = await sharp(meta.data)
    .resize(width, height, { fit: source.fit === 'cover' ? 'fill' : 'cover', position: 'centre' })
    .ensureAlpha()
    .png()
    .toBuffer();
  return { png, width, height };
}

async function prepareLayer(
  clip: LayerClip,
  index: number,
  timeline: LocalTimeline,
  downloads: Downloads,
  ctx: PrepareContext,
  notes: string[],
): Promise<PreparedLayer> {
  const { frame } = timeline;
  if (clip.source.kind === 'video') {
    if (clip.source.fit !== 'none' && clip.source.fit !== 'crop')
      notes.push(`overlay video fit ${clip.source.fit} drawn as crop`);
    return {
      kind: 'video',
      file: await downloads.file(clip.source.src),
      fit: clip.source.fit === 'none' ? 'none' : 'cover',
    };
  }
  const picture = await layerPicture(clip, downloads, timeline, ctx, notes);
  let png = picture.png;
  let size = { width: picture.width, height: picture.height };
  let shift = { x: 0, y: 0 };
  if (clip.rotationDeg !== 0) {
    // Shotstack rotates around the clip's centre; sharp grows the canvas to hold the result.
    const rotated = await sharp(png)
      .rotate(clip.rotationDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer({ resolveWithObject: true });
    shift = {
      x: Math.round((rotated.info.width - size.width) / 2),
      y: Math.round((rotated.info.height - size.height) / 2),
    };
    png = rotated.data;
    size = { width: rotated.info.width, height: rotated.info.height };
  }
  png = await withOpacity(png, clip.opacity);
  const placed = placeOnFrame(clip, picture, frame);
  const at = { x: placed.x - shift.x, y: placed.y - shift.y };
  const file = `layer-${index}.png`;
  await writeFile(path.join(ctx.dir, file), png);
  return { kind: 'image', file, x: at.x, y: at.y };
}

/** Download and draw everything the timeline needs; returns the ffmpeg-ready description. */
export async function prepareTimeline(
  timeline: LocalTimeline,
  ctx: PrepareContext,
): Promise<{ prepared: PreparedTimeline; notes: string[] }> {
  const downloads = new Downloads(ctx);
  const notes: string[] = [...timeline.notes];
  const base: PreparedBase[] = [];
  for (const [i, clip] of timeline.base.entries()) {
    base.push(await prepareBase(clip, i, timeline, downloads, ctx, notes));
  }
  const layers: PreparedLayer[] = [];
  for (const [i, clip] of timeline.layers.entries()) {
    layers.push(await prepareLayer(clip, i, timeline, downloads, ctx, notes));
  }
  const audio: string[] = [];
  for (const clip of timeline.audio) audio.push(await downloads.file(clip.src));
  return { prepared: { timeline, base, layers, audio }, notes: [...new Set(notes)] };
}
