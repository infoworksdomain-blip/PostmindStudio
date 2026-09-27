import { spawn } from 'node:child_process';
import { ConfigurationError, ValidationError } from '../../errors';

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
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run ffmpeg/ffprobe with an argv array (no shell). Also used by the overlay pre-renderer. */
export function run(
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

export function parseBlackdetect(stderr: string): BlackInterval[] {
  const intervals: BlackInterval[] = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g;
  for (const m of stderr.matchAll(re)) {
    intervals.push({ startSec: Number(m[1]), endSec: Number(m[2]), durationSec: Number(m[3]) });
  }
  return intervals;
}

/** The ebur128 summary ends with "Integrated loudness: … I: -14.2 LUFS". */
export function parseIntegratedLoudness(stderr: string): number | null {
  const summary = stderr.lastIndexOf('Integrated loudness:');
  if (summary === -1) return null;
  const m = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr.slice(summary));
  if (!m?.[1] || m[1] === '-inf') return null;
  return Number(m[1]);
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
          `blackdetect=d=${minDurationSec}:pic_th=0.98`,
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
        [
          '-hide_banner',
          '-nostats',
          '-i',
          url,
          '-vn',
          '-af',
          'ebur128=framelog=quiet',
          '-f',
          'null',
          '-',
        ],
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
  };
}
