import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, ValidationError } from '../../errors';
import { ffmpegLimiter, type ConcurrencyLimiter } from './process-limit';

// Media inspection for Layer 7 (render metadata) and Layer 8 auto-checks (spec 13.1), via the
// system ffprobe/ffmpeg (FFPROBE_PATH / FFMPEG_PATH override the PATH lookup). Arguments are
// passed as an argv array: no shell, so URLs can't inject commands.

export interface MediaProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  videoProfile: string | null;
  audioCodec: string | null;
  formatName: string;
  bitRateKbps: number;
}

export interface BlackInterval {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface MediaInspector {
  probe(url: string): Promise<MediaProbe>;
  /** Black intervals at least `minDurationSec` long (ffmpeg blackdetect). */
  blackIntervals(url: string, minDurationSec: number): Promise<BlackInterval[]>;
  /** Integrated loudness in LUFS (ffmpeg ebur128), or null when there is no audio stream. */
  integratedLoudness(url: string): Promise<number | null>;
  /** Scene-change timestamps in seconds (select=gt(scene,t) + showinfo), ascending, excl. 0. */
  sceneChanges(url: string, threshold: number): Promise<number[]>;
  /** One JPEG frame at `atSec`, scaled to at most `maxWidth` wide. */
  frameJpeg(url: string, atSec: number, maxWidth: number): Promise<Uint8Array>;
  /**
   * Low-resolution, length-capped H.264 + AAC rendition (library previews, Addendum A3.10). Keeps
   * the first audio stream (operator decision 2026-10-01, BACKLOG 20.17); a source without audio
   * gives a valid silent rendition.
   */
  previewClip(url: string, maxWidth: number, maxSec: number): Promise<Uint8Array>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run ffmpeg/ffprobe with an argv array (no shell). Also used by the overlay pre-renderer, the
 * mastering step and the thumbnail composer. Waits for a slot when STUDIO_FFMPEG_MAX_CONCURRENT
 * caps the children per process (process-limit.ts); the timeout starts once the child starts.
 */
export function run(
  binary: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<RunResult> {
  let limiter: ConcurrencyLimiter;
  try {
    limiter = ffmpegLimiter();
  } catch (err) {
    return Promise.reject(err);
  }
  return limiter.run(() => spawnProcess(binary, args, timeoutMs, cwd));
}

function spawnProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(cwd && { cwd }),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 5_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new ConfigurationError(
              `${binary} not found; install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH`,
            )
          : err,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return Number(rate) || 0;
  return Math.round((num / den) * 1000) / 1000;
}

interface FfprobeJson {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    profile?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
}

export function parseFfprobe(json: string): MediaProbe {
  let data: FfprobeJson;
  try {
    data = JSON.parse(json) as FfprobeJson;
  } catch {
    throw new ValidationError('ffprobe returned invalid JSON');
  }
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  if (!video || !data.format) throw new ValidationError('Media has no video stream');
  return {
    durationSec: Number(data.format.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? null,
    videoProfile: video.profile ?? null,
    audioCodec: audio?.codec_name ?? null,
    formatName: data.format.format_name ?? '',
    bitRateKbps: Math.round(Number(data.format.bit_rate ?? 0) / 1000),
  };
}

/**
 * ffmpeg blackdetect thresholds (ffmpeg-filters "blackdetect"; libavfilter/vf_blackdetect.c),
 * pinned here rather than left to the filter's defaults so a different ffmpeg build cannot move
 * them. BACKLOG 20.22 reviewed them against the first production QUALITY_FAILED (QA run 3):
 *   - pix_th 0.10 (the filter default): a pixel is black when its luma is under 10 % of the luma
 *     range, 16 + 0.10 × 219 ≈ 38 on limited-range video. Dark but real footage (night scenes,
 *     dark brand colours) stays above it; the composer keeps every card and the timeline
 *     backdrop at luma ≥ 0.2 (edl-backdrop.ts), twice this threshold;
 *   - pic_th 0.98 (the filter default): a frame counts as black only when 98 % of its pixels are,
 *     so a black card is caught once its text has faded or is small, while a dark shot with any
 *     lit subject is not;
 *   - d = the shortest interval reported; the gate asks for BLACK_FRAME_MAX_SEC (spec 13.1:
 *     black > 500 ms fails), so an intentional dip of up to half a second (a Shotstack
 *     `fadeFast`, or the darkest part of a 1 s `fade`) is not a failure, while a real gap (an
 *     empty or black card, a clip that ends early) is.
 */
export const BLACKDETECT_PIXEL_THRESHOLD = 0.1;
export const BLACKDETECT_PICTURE_THRESHOLD = 0.98;

/** The -vf argument for blackdetect reporting intervals of at least `minDurationSec`. */
export function blackdetectFilter(minDurationSec: number): string {
  if (!Number.isFinite(minDurationSec) || minDurationSec <= 0)
    throw new ValidationError(`blackdetect needs a positive duration, got ${minDurationSec}`);
  return `blackdetect=d=${minDurationSec}:pix_th=${BLACKDETECT_PIXEL_THRESHOLD}:pic_th=${BLACKDETECT_PICTURE_THRESHOLD}`;
}

// ffmpeg prints times with av_ts2timestr ("%.6g"), so a tiny value can appear as 1e-05.
const TIME = String.raw`(\d+(?:\.\d+)?(?:e[-+]?\d+)?)`;
const BLACK_LINE = new RegExp(
  String.raw`black_start:\s*${TIME}\s+black_end:\s*${TIME}\s+black_duration:\s*${TIME}`,
  'gi',
);

/** "[blackdetect @ 0x…] black_start:7.2 black_end:8 black_duration:0.8" lines, in order. */
export function parseBlackdetect(stderr: string): BlackInterval[] {
  const intervals: BlackInterval[] = [];
  for (const m of stderr.matchAll(BLACK_LINE)) {
    intervals.push({ startSec: Number(m[1]), endSec: Number(m[2]), durationSec: Number(m[3]) });
  }
  return intervals;
}

/**
 * ebur128 with its per-frame lines at verbose level, so only the summary reaches stderr. framelog
 * accepts only info and verbose on ffmpeg 5.1 (Debian bookworm, the runtime image); `quiet` is newer
 * and made every loudness read fail on the first server ("Error setting option framelog to value
 * quiet", all 25 library imports, 2026-10-01).
 */
export const LOUDNESS_FILTER = 'ebur128=framelog=verbose';

/**
 * Times to try for a single frame, latest first. Some files declare a longer duration than their video
 * stream really has (a corpus reel said 15.09 s but had no frames after about 10 s); ffmpeg then exits 0
 * with "Output file is empty" and no JPEG, which failed the import with ENOENT (2026-10-01). Falling back
 * to half the time, then the first frame, still gives the analysis a representative picture.
 */
export function frameFallbackTimes(atSec: number): number[] {
  const t = Math.max(0, atSec);
  return [...new Set([t, t / 2, 0].map((x) => Math.round(x * 1000) / 1000))];
}

/** The ebur128 summary ends with "Integrated loudness: … I: -14.2 LUFS". */
export function parseIntegratedLoudness(stderr: string): number | null {
  const summary = stderr.lastIndexOf('Integrated loudness:');
  if (summary === -1) return null;
  const m = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr.slice(summary));
  if (!m?.[1] || m[1] === '-inf') return null;
  return Number(m[1]);
}

/** pts_time values from showinfo lines (ffmpeg-filters: showinfo prints key:value pairs). */
export function parseSceneChanges(stderr: string): number[] {
  const times = new Set<number>();
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('showinfo')) continue;
    const match = line.match(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (match) {
      const t = Math.round(Number(match[1]) * 1000) / 1000;
      if (t > 0) times.add(t);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Output file name of previewClip inside its temporary directory. */
export const PREVIEW_FILE = 'preview.mp4';

/**
 * ffmpeg arguments for a library preview rendition (Addendum A3.10: low-res, at most `maxSec`).
 * BACKLOG 20.17 (operator decision 2026-10-01): previews keep their sound. `-map 0:a:0?` maps the
 * first audio stream only when there is one (the trailing `?` makes the map optional, see
 * ffmpeg's -map documentation), so a silent source still gives a valid video-only MP4; the
 * `-c:a` options then apply to no stream and ffmpeg ignores them. AAC stereo at 96 kb/s is
 * modest next to the video and plays in every browser; +faststart lets playback start before
 * the whole file has arrived.
 */
export function previewClipArgs(url: string, maxWidth: number, maxSec: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-i',
    url,
    '-t',
    maxSec.toFixed(3),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale='min(${Math.round(maxWidth)},iw)':-2,fps=15`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-y',
    PREVIEW_FILE,
  ];
}

export function createFfmpegInspector(
  options: { ffmpegPath?: string; ffprobePath?: string; timeoutMs?: number } = {},
): MediaInspector {
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async probe(url) {
      const r = await run(
        ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url],
        timeoutMs,
      );
      if (r.code !== 0) throw new ValidationError(`ffprobe failed: ${r.stderr.slice(-500)}`);
      return parseFfprobe(r.stdout);
    },
    async blackIntervals(url, minDurationSec) {
      const r = await run(
        ffmpeg,
        [
          '-hide_banner',
          '-nostats',
          '-i',
          url,
          '-vf',
          blackdetectFilter(minDurationSec),
          '-an',
          '-f',
          'null',
          '-',
        ],
        timeoutMs,
      );
      if (r.code !== 0)
        throw new ValidationError(`ffmpeg blackdetect failed: ${r.stderr.slice(-500)}`);
      return parseBlackdetect(r.stderr);
    },
    async integratedLoudness(url) {
      const r = await run(
        ffmpeg,
        ['-hide_banner', '-nostats', '-i', url, '-vn', '-af', LOUDNESS_FILTER, '-f', 'null', '-'],
        timeoutMs,
      );
      if (r.code !== 0) {
        if (
          /does not contain any stream|matches no streams|Output file #0 does not contain/i.test(
            r.stderr,
          )
        )
          return null;
        throw new ValidationError(`ffmpeg ebur128 failed: ${r.stderr.slice(-500)}`);
      }
      return parseIntegratedLoudness(r.stderr);
    },
    async sceneChanges(url, threshold) {
      const r = await run(
        ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-i',
          url,
          '-an',
          '-sn',
          '-dn',
          '-vf',
          `select='gt(scene,${threshold})',showinfo`,
          '-f',
          'null',
          '-',
        ],
        timeoutMs,
      );
      if (r.code !== 0)
        throw new ValidationError(`ffmpeg scene detection failed: ${r.stderr.slice(-500)}`);
      return parseSceneChanges(r.stderr);
    },
    async frameJpeg(url, atSec, maxWidth) {
      const dir = await mkdtemp(join(tmpdir(), 'studio-frame-'));
      try {
        let last = '';
        for (const t of frameFallbackTimes(atSec)) {
          const r = await run(
            ffmpeg,
            [
              '-hide_banner',
              '-nostdin',
              '-ss',
              t.toFixed(3),
              '-i',
              url,
              '-frames:v',
              '1',
              '-vf',
              `scale='min(${Math.round(maxWidth)},iw)':-2`,
              '-q:v',
              '3',
              '-y',
              'frame.jpg',
            ],
            timeoutMs,
            dir,
          );
          if (r.code !== 0)
            throw new ValidationError(`ffmpeg frame grab failed: ${r.stderr.slice(-500)}`);
          const bytes = await readFile(join(dir, 'frame.jpg')).catch(() => null);
          if (bytes && bytes.length > 0) return new Uint8Array(bytes);
          last = r.stderr.slice(-300);
        }
        throw new ValidationError(`ffmpeg produced no frame near ${atSec.toFixed(3)}s: ${last}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async previewClip(url, maxWidth, maxSec) {
      const dir = await mkdtemp(join(tmpdir(), 'studio-preview-'));
      try {
        const r = await run(ffmpeg, previewClipArgs(url, maxWidth, maxSec), timeoutMs, dir);
        if (r.code !== 0)
          throw new ValidationError(`ffmpeg preview failed: ${r.stderr.slice(-500)}`);
        return new Uint8Array(await readFile(join(dir, PREVIEW_FILE)));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
