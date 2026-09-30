import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, UpstreamServiceError } from '../../errors';
import { run } from '../pipeline/media-probe';

// 15.A3 — thumbnail rendering with FFmpeg (spec A6.5: "a thumbnail candidate from a keyframe +
// text overlay; the background image is chosen from the library"). Layout: the library image
// fills the frame (scaled to cover, blurred), the keyframe sits centred on it at 72 % width, and
// the hook text is drawn in a box in the lower third. Without a library image the keyframe fills
// the frame. Text reaches FFmpeg only through textfile= and every process gets an argv array in
// a private temp directory (same safety rules as overlays/prerender.ts).

const TIMEOUT_MS = 90_000;
const MAX_LINE_CHARS = 22;
const MAX_LINES = 3;

export interface ThumbnailRequest {
  /** Signed URL of the render (the keyframe is read at `atSec`). */
  videoUrl: string;
  atSec: number;
  /** Signed URL of a library image used as the background; absent = keyframe only. */
  backgroundUrl?: string;
  overlayText?: string;
  width: number;
  height: number;
  /** A TTF for the text (<fonts base URL>/Montserrat.ttf; fonts-host.ts); absent = FFmpeg's default font. */
  fontUrl?: string;
}

export interface ThumbnailComposer {
  /** A JPEG of exactly width × height. */
  compose(request: ThumbnailRequest): Promise<Uint8Array>;
}

/** Output size for a render's aspect ratio (YouTube's recommended 1280×720 for 16:9). */
export function thumbnailSize(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
    default:
      return { width: 1280, height: 720 };
  }
}

/** Break text into at most three short lines (FFmpeg drawtext does not wrap). */
export function wrapText(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > MAX_LINE_CHARS && current) {
      lines.push(current);
      current = word;
    } else current = next;
    if (lines.length === MAX_LINES) break;
  }
  if (current && lines.length < MAX_LINES) lines.push(current);
  return lines.join('\n').slice(0, 200);
}

/** The filter graph (exported for tests; inputs are [0] keyframe, [1] background). */
export function thumbnailFilter(input: {
  width: number;
  height: number;
  withBackground: boolean;
  withText: boolean;
  withFont: boolean;
}): string {
  const { width: w, height: h } = input;
  const cover = (label: string, out: string) =>
    `[${label}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[${out}]`;
  const parts: string[] = [];
  if (input.withBackground) {
    parts.push(`${cover('1:v', 'bgc')}`, '[bgc]boxblur=12:2[bg]');
    parts.push(
      `[0:v]scale=${Math.round(w * 0.72)}:${Math.round(h * 0.72)}:force_original_aspect_ratio=decrease,setsar=1[kf]`,
    );
    parts.push('[bg][kf]overlay=(W-w)/2:(H-h)/2[base]');
  } else {
    parts.push(cover('0:v', 'base'));
  }
  if (input.withText) {
    const size = Math.round(Math.min(w, h) * 0.075);
    const font = input.withFont ? ':fontfile=font.ttf' : '';
    parts.push(
      `[base]drawtext=textfile=text.txt${font}:fontsize=${size}:fontcolor=white:line_spacing=${Math.round(size * 0.25)}:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size * 0.45)}:x=(w-text_w)/2:y=h*0.78-text_h/2[out]`,
    );
  } else {
    parts.push('[base]null[out]');
  }
  return parts.join(';');
}

export function createFfmpegThumbnailComposer(
  options: { ffmpegPath?: string; fetchImpl?: typeof fetch } = {},
): ThumbnailComposer {
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async compose(request) {
      const dir = await mkdtemp(join(tmpdir(), 'studio-thumb-'));
      try {
        const text = request.overlayText ? wrapText(request.overlayText) : '';
        if (text) await writeFile(join(dir, 'text.txt'), text, 'utf8');
        let withFont = false;
        if (text && request.fontUrl) {
          const res = await fetchImpl(request.fontUrl, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new ConfigurationError(`Thumbnail font not reachable (${res.status})`);
          await writeFile(join(dir, 'font.ttf'), new Uint8Array(await res.arrayBuffer()));
          withFont = true;
        }
        const args = [
          '-hide_banner',
          '-nostdin',
          '-ss',
          Math.max(0, request.atSec).toFixed(3),
          '-i',
          request.videoUrl,
          ...(request.backgroundUrl ? ['-i', request.backgroundUrl] : []),
          '-filter_complex',
          thumbnailFilter({
            width: request.width,
            height: request.height,
            withBackground: Boolean(request.backgroundUrl),
            withText: Boolean(text),
            withFont,
          }),
          '-map',
          '[out]',
          '-frames:v',
          '1',
          '-q:v',
          '3',
          '-y',
          'thumb.jpg',
        ];
        const result = await run(ffmpeg, args, TIMEOUT_MS, dir);
        if (result.code !== 0)
          throw new UpstreamServiceError(
            `ffmpeg thumbnail failed: ${result.stderr.slice(-300) || `exit ${result.code}`}`,
          );
        return new Uint8Array(await readFile(join(dir, 'thumb.jpg')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
