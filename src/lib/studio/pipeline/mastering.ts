import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../../errors';
import { providerOutputKey } from '../storage';
import type { PipelineDeps } from './deps';
import { run, type MediaProbe } from './media-probe';
import { LUFS_RANGE } from './quality-checks';

// BACKLOG 13.26 — render mastering after compose (spec 13.1 "Audio present: LUFS between −18
// and −10 → regenerate audio"; "Codec / container: H.264 … MP4 → re-encode"). A render that the
// quality gate would fail on loudness or codec is fixed here instead of reaching QUALITY_FAILED.
//
//  - Loudness: ffmpeg `loudnorm` (EBU R128) in two passes, per the filter documentation
//    (ffmpeg.org/ffmpeg-filters.html#loudnorm, read 2026-09-27): pass 1 measures with
//    print_format=json (input_i, input_tp, input_lra, input_thresh, target_offset); pass 2 feeds
//    them back as measured_I/measured_TP/measured_LRA/measured_thresh/offset with linear=true,
//    which applies one gain instead of dynamic compression. loudnorm resamples to 192 kHz
//    internally, so the output rate is set back to 48 kHz. Target −14 LUFS (the plan's target,
//    the middle of the gate's −18…−10 window), true peak −1.5 dBTP, LRA 11 LU.
//  - Codec: the gate passes H.264 in an MP4 container. A render that is not gets re-encoded with
//    libx264, Baseline profile (spec 13.1 "H.264 baseline profile MP4 for platform compat"),
//    yuv420p, +faststart. Compliant video is stream-copied (no quality loss, no encode time).
//  - Skipped when already compliant (the usual Shotstack output), so the common case costs one
//    ebur128 read, which the compose step already needed for nothing else.
// COST/TIME: no provider spend; worker CPU only. Pass 1 decodes the audio (≈ 1–2 s per minute of
// video). Pass 2 with video copy is similar; a full re-encode runs at roughly real time for 1080p
// with preset `medium` on one core. The mastered file is read into memory for the upload (a
// 1080p 8-minute render is ≈ 150–300 MB), the same as other ffmpeg outputs here.

export const LOUDNESS_TARGET_LUFS = -14;
export const TRUE_PEAK_DBTP = -1.5;
export const LOUDNESS_RANGE_LU = 11;
const OUTPUT_SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = '192k';
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface MasteringPlan {
  normaliseAudio: boolean;
  reencodeVideo: boolean;
  reasons: string[];
}

export interface LoudnormMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

export interface RenderMastering {
  /** Pass 1: loudnorm measurement of the render's audio. */
  measure(url: string): Promise<LoudnormMeasurement>;
  /** Pass 2 (and/or re-encode): the mastered MP4 bytes. */
  master(
    url: string,
    plan: MasteringPlan,
    measured: LoudnormMeasurement | null,
  ): Promise<Uint8Array>;
}

/** Mirrors the quality gate's codec check (quality-checks.ts): H.264 video in an MP4 container. */
export function codecCompliant(probe: MediaProbe): boolean {
  return probe.videoCodec === 'h264' && probe.formatName.split(',').includes('mp4');
}

export function planMastering(probe: MediaProbe, loudnessLufs: number | null): MasteringPlan {
  const reasons: string[] = [];
  const [min, max] = LUFS_RANGE;
  // No audio stream (or silence) cannot be normalised; the gate reports it.
  const normaliseAudio =
    probe.audioCodec !== null &&
    loudnessLufs !== null &&
    (loudnessLufs < min || loudnessLufs > max);
  if (normaliseAudio) {
    reasons.push(
      `loudness ${loudnessLufs?.toFixed(1)} LUFS outside ${min}…${max}; normalised to ${LOUDNESS_TARGET_LUFS}`,
    );
  }
  const reencodeVideo = !codecCompliant(probe);
  if (reencodeVideo) {
    reasons.push(
      `${probe.videoCodec ?? 'no video codec'} in ${probe.formatName || 'unknown container'}; re-encoded to H.264 MP4`,
    );
  }
  return { normaliseAudio, reencodeVideo, reasons };
}

export function masteringNeeded(plan: MasteringPlan): boolean {
  return plan.normaliseAudio || plan.reencodeVideo;
}

const num = (value: unknown, name: string): number => {
  const n = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new ValidationError(`loudnorm reported no numeric ${name}`);
  return n;
};

/** The JSON block loudnorm prints at the end of pass 1 (print_format=json). */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement {
  const end = stderr.lastIndexOf('}');
  const start = stderr.lastIndexOf('{', end);
  if (start === -1 || end === -1) throw new ValidationError('loudnorm printed no measurement');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new ValidationError('loudnorm measurement is not valid JSON');
  }
  return {
    inputI: num(json.input_i, 'input_i'),
    inputTp: num(json.input_tp, 'input_tp'),
    inputLra: num(json.input_lra, 'input_lra'),
    inputThresh: num(json.input_thresh, 'input_thresh'),
    targetOffset: num(json.target_offset, 'target_offset'),
  };
}

const target = `I=${LOUDNESS_TARGET_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}`;

export function measureFilter(): string {
  return `loudnorm=${target}:print_format=json`;
}

export function normaliseFilter(m: LoudnormMeasurement): string {
  return [
    `loudnorm=${target}`,
    `measured_I=${m.inputI}`,
    `measured_TP=${m.inputTp}`,
    `measured_LRA=${m.inputLra}`,
    `measured_thresh=${m.inputThresh}`,
    `offset=${m.targetOffset}`,
    'linear=true',
    'print_format=summary',
  ].join(':');
}

/** ffmpeg argv for the mastering pass (no shell: the URL cannot inject arguments). */
export function masterArgs(
  input: string,
  plan: MasteringPlan,
  measured: LoudnormMeasurement | null,
  output: string,
): string[] {
  const video = plan.reencodeVideo
    ? [
        '-c:v',
        'libx264',
        '-profile:v',
        'baseline',
        '-level:v',
        '4.0',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
      ]
    : ['-c:v', 'copy'];
  const audio =
    plan.normaliseAudio && measured
      ? ['-af', normaliseFilter(measured), '-ar', String(OUTPUT_SAMPLE_RATE)]
      : [];
  return [
    '-hide_banner',
    '-nostdin',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    ...video,
    ...audio,
    '-c:a',
    'aac',
    '-b:a',
    AUDIO_BITRATE,
    '-movflags',
    '+faststart',
    '-y',
    output,
  ];
}

export function createFfmpegMastering(
  options: { ffmpegPath?: string; timeoutMs?: number } = {},
): RenderMastering {
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async measure(url) {
      const r = await run(
        ffmpeg,
        ['-hide_banner', '-nostdin', '-i', url, '-vn', '-af', measureFilter(), '-f', 'null', '-'],
        timeoutMs,
      );
      if (r.code !== 0)
        throw new ValidationError(`ffmpeg loudnorm pass 1 failed: ${r.stderr.slice(-500)}`);
      return parseLoudnormJson(r.stderr);
    },
    async master(url, plan, measured) {
      const dir = await mkdtemp(join(tmpdir(), 'studio-master-'));
      try {
        const r = await run(
          ffmpeg,
          masterArgs(url, plan, measured, 'mastered.mp4'),
          timeoutMs,
          dir,
        );
        if (r.code !== 0)
          throw new ValidationError(`ffmpeg mastering failed: ${r.stderr.slice(-500)}`);
        return new Uint8Array(await readFile(join(dir, 'mastered.mp4')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface MasteringReport {
  applied: boolean;
  reasons: string[];
  loudnessBeforeLufs: number | null;
  /** loudnorm pass-1 integrated loudness (only when normalised). */
  measuredLufs?: number;
}

interface StoredRender {
  bucket: string;
  key: string;
  url: string;
}

/**
 * Master a composed render in place of the provider's file when it would fail the gate's
 * loudness or codec checks. Returns the (possibly new) stored object and its probe. Without a
 * mastering implementation the render is returned untouched and the report says why.
 */
export async function masterStoredRender(
  deps: Pick<PipelineDeps, 'media' | 'mastering' | 'storage' | 'logger'>,
  input: {
    stored: StoredRender;
    probe: MediaProbe;
    organisationId: string;
    projectId: string;
  },
): Promise<{ stored: StoredRender; probe: MediaProbe; report: MasteringReport }> {
  const loudness = input.probe.audioCodec
    ? await deps.media.integratedLoudness(input.stored.url)
    : null;
  const plan = planMastering(input.probe, loudness);
  const skip = (reasons: string[]) => ({
    stored: input.stored,
    probe: input.probe,
    report: { applied: false, reasons, loudnessBeforeLufs: loudness },
  });
  if (!masteringNeeded(plan)) return skip(['already compliant']);
  if (!deps.mastering) return skip([...plan.reasons, 'mastering not configured; left as rendered']);
  const measured = plan.normaliseAudio ? await deps.mastering.measure(input.stored.url) : null;
  const bytes = await deps.mastering.master(input.stored.url, plan, measured);
  const mastered = await deps.storage.put({
    bucket: input.stored.bucket,
    key: providerOutputKey({
      organisationId: input.organisationId,
      projectId: input.projectId,
      providerId: 'mastered',
      extension: 'mp4',
    }),
    body: bytes,
    contentType: 'video/mp4',
  });
  await deps.storage.delete(input.stored.bucket, input.stored.key);
  const probe = await deps.media.probe(mastered.url);
  deps.logger.info(
    { projectId: input.projectId, reasons: plan.reasons, bytes: bytes.byteLength },
    'render mastered',
  );
  return {
    stored: { bucket: mastered.bucket, key: mastered.key, url: mastered.url },
    probe,
    report: {
      applied: true,
      reasons: plan.reasons,
      loudnessBeforeLufs: loudness,
      ...(measured && { measuredLufs: measured.inputI }),
    },
  };
}
