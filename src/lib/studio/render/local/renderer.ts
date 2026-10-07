import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpstreamServiceError, ValidationError } from '../../../errors';
import {
  parseLoudnormJson,
  SILENCE_LUFS,
  type LoudnormMeasurement,
} from '../../pipeline/mastering';
import { run } from '../../pipeline/media-probe';
import { hasAudio, loudnessArgs, OUTPUT_FILE, renderArgs } from './ffmpeg-args';
import { prepareTimeline } from './prepare';
import { readTimeline } from './timeline';

// BACKLOG 23.5 — Studio's own renderer for the cheap formats (slideshows, wall of text): the
// composer's Shotstack edit drawn with ffmpeg on the worker (timeline.ts → prepare.ts →
// ffmpeg-args.ts). Every ffmpeg child goes through media-probe.ts `run()`, so the process-wide
// STUDIO_FFMPEG_MAX_CONCURRENT limiter (process-limit.ts) bounds them like every other ffmpeg
// call; each aspect ratio is its own ffmpeg process. Loudness: the music mix is measured first
// (loudnorm pass 1, audio only, about a second) and the render applies one linear gain to the
// mastering target (pipeline/mastering.ts, −14 LUFS), so the gate's −18…−10 window holds without
// a second encode. A NotImplementedError from readTimeline means "not something this renderer
// draws" (the caller uses Shotstack); anything else is an infrastructure failure.

export const LOCAL_RENDERER_ID = 'local-ffmpeg';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;

export interface LocalRenderResult {
  readonly bytes: Uint8Array;
  readonly renderMs: number;
  /** Parity notes: what was drawn approximately. */
  readonly notes: readonly string[];
  /** Integrated loudness of the mix before normalisation (null = silence / no audio). */
  readonly measuredLufs: number | null;
}

export interface LocalRenderer {
  readonly providerId: typeof LOCAL_RENDERER_ID;
  /** ffmpeg runs here (checked once per process). */
  available(): Promise<boolean>;
  render(edit: Record<string, unknown>, ctx: { fetch: typeof fetch }): Promise<LocalRenderResult>;
}

export interface LocalRendererOptions {
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly fontsDir?: string;
  readonly now?: () => number;
}

export function createLocalRenderer(options: LocalRendererOptions = {}): LocalRenderer {
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let availability: Promise<boolean> | undefined;

  const measure = async (dir: string, args: string[]): Promise<LoudnormMeasurement | null> => {
    const r = await run(ffmpeg, args, timeoutMs, dir);
    if (r.code !== 0)
      throw new UpstreamServiceError(`ffmpeg loudness pass failed: ${r.stderr.slice(-500)}`);
    try {
      const m = parseLoudnormJson(r.stderr);
      return m.inputI > SILENCE_LUFS ? m : null;
    } catch (err) {
      // "-inf" for a silent mix: nothing to normalise.
      if (err instanceof ValidationError) return null;
      throw err;
    }
  };

  return {
    providerId: LOCAL_RENDERER_ID,
    available() {
      availability ??= run(ffmpeg, ['-hide_banner', '-version'], VERSION_TIMEOUT_MS).then(
        (r) => r.code === 0,
        () => false,
      );
      return availability;
    },
    async render(edit, ctx) {
      const started = now();
      const timeline = readTimeline(edit);
      const dir = await mkdtemp(path.join(tmpdir(), 'studio-local-render-'));
      try {
        const { prepared, notes } = await prepareTimeline(timeline, {
          dir,
          fetch: ctx.fetch,
          ...(options.fontsDir && { fontsDir: options.fontsDir }),
        });
        const loudness = hasAudio(timeline) ? await measure(dir, loudnessArgs(prepared)) : null;
        const r = await run(ffmpeg, renderArgs(prepared, loudness), timeoutMs, dir);
        if (r.code !== 0)
          throw new UpstreamServiceError(`ffmpeg local render failed: ${r.stderr.slice(-800)}`);
        const bytes = new Uint8Array(await readFile(path.join(dir, OUTPUT_FILE)));
        return {
          bytes,
          renderMs: now() - started,
          notes,
          measuredLufs: loudness?.inputI ?? null,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
