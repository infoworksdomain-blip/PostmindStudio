import type { AspectRatio } from '../providers/interface';
import type { ContentSafetyScan } from '../providers/hive';
import type { BlackInterval, MediaProbe } from './media-probe';

// Layer 8 auto-check panel (spec 13.1). Pure evaluation: given measurements, decide pass/fail.
// Fail-closed: a check that should run but could not produces a failure, never a pass.
// Checks that depend on features not built yet (captions, watermark, brand-kit rendering,
// audio-sync analysis) are recorded as `not_run` with the reason — never reported as passed.

export type CheckStatus = 'passed' | 'failed' | 'not_run';
/** block = content-safety block (no customer force-approve, spec 13.5); error = force-approvable. */
export type CheckSeverity = 'block' | 'error' | 'info';

export interface QualityCheck {
  code: string;
  status: CheckStatus;
  severity: CheckSeverity;
  detail: string;
}

export const DURATION_TOLERANCE_SEC = 2;
export const BLACK_FRAME_MAX_SEC = 0.5;
export const LUFS_RANGE: [number, number] = [-18, -10];
const ASPECT_TOLERANCE = 0.01;

// Content-safety policy (spec 13.2 categories; "conservative in v1.0"). Hive class names from
// docs.thehive.ai. Scores are per-head probabilities in [0, 1].
export const SAFETY_BLOCK_THRESHOLD = 0.8;
export const SAFETY_REVIEW_THRESHOLD = 0.8;
export const SAFETY_BLOCK_CLASSES = [
  'general_nsfw',
  'yes_sexual_activity',
  'yes_realistic_nsfw',
  'yes_genitals',
  'yes_female_nudity',
  'yes_male_nudity',
  'yes_sexual_intent',
  'animal_genitalia_and_human',
  'very_bloody',
  'human_corpse',
  'yes_self_harm',
  'hanging',
  'noose',
  'yes_nazi',
  'yes_kkk',
  'yes_terrorist',
  'yes_child_safety',
] as const;
export const SAFETY_REVIEW_CLASSES = [
  'general_suggestive',
  'a_little_bloody',
  'yes_fight',
  'yes_animal_abuse',
  'gun_in_hand',
  'knife_in_hand',
  'illicit_injectables',
  'yes_pills',
  'yes_marijuana',
  'yes_confederate',
  'yes_middle_finger',
] as const;

export interface QualityInputs {
  target: { durationSec: number; aspectRatio: AspectRatio };
  probe: MediaProbe;
  blackIntervals: BlackInterval[];
  loudnessLufs: number | null;
  contentSafety: { scan: ContentSafetyScan } | { unavailable: string };
}

const RATIO_VALUE: Record<AspectRatio, number> = {
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
};

export function evaluateContentSafety(input: QualityInputs['contentSafety']): QualityCheck {
  if ('unavailable' in input) {
    return {
      code: 'content_safety',
      status: 'failed',
      severity: 'block',
      detail: `Scan could not run: ${input.unavailable}`,
    };
  }
  const hits = (classes: readonly string[], threshold: number) =>
    classes
      .filter((c) => (input.scan.maxScores[c] ?? 0) >= threshold)
      .map((c) => `${c}=${(input.scan.maxScores[c] ?? 0).toFixed(2)}`);
  const blocked = hits(SAFETY_BLOCK_CLASSES, SAFETY_BLOCK_THRESHOLD);
  if (blocked.length) {
    return {
      code: 'content_safety',
      status: 'failed',
      severity: 'block',
      detail: `Blocked: ${blocked.join(', ')}`,
    };
  }
  const review = hits(SAFETY_REVIEW_CLASSES, SAFETY_REVIEW_THRESHOLD);
  if (review.length) {
    return {
      code: 'content_safety',
      status: 'failed',
      severity: 'error',
      detail: `Needs review: ${review.join(', ')}`,
    };
  }
  return {
    code: 'content_safety',
    status: 'passed',
    severity: 'info',
    detail: `${input.scan.framesAnalysed} frames scanned, no flagged classes`,
  };
}

export function evaluateQuality(input: QualityInputs): QualityCheck[] {
  const { probe, target } = input;
  const checks: QualityCheck[] = [];

  const drift = Math.abs(probe.durationSec - target.durationSec);
  checks.push({
    code: 'duration_match',
    status: drift <= DURATION_TOLERANCE_SEC ? 'passed' : 'failed',
    severity: 'error',
    detail: `rendered ${probe.durationSec.toFixed(2)}s vs target ${target.durationSec}s (±${DURATION_TOLERANCE_SEC}s)`,
  });

  const longBlack = input.blackIntervals.filter((b) => b.durationSec > BLACK_FRAME_MAX_SEC);
  checks.push({
    code: 'black_frames',
    status: longBlack.length === 0 ? 'passed' : 'failed',
    severity: 'error',
    detail: longBlack.length
      ? `black ${longBlack.map((b) => `${b.startSec.toFixed(1)}–${b.endSec.toFixed(1)}s`).join(', ')}`
      : `no black segment > ${BLACK_FRAME_MAX_SEC * 1000}ms`,
  });

  const [minLufs, maxLufs] = LUFS_RANGE;
  const audioOk =
    probe.audioCodec !== null &&
    input.loudnessLufs !== null &&
    input.loudnessLufs >= minLufs &&
    input.loudnessLufs <= maxLufs;
  checks.push({
    code: 'audio_present',
    status: audioOk ? 'passed' : 'failed',
    severity: 'error',
    detail:
      probe.audioCodec === null || input.loudnessLufs === null
        ? 'no audio stream'
        : `integrated loudness ${input.loudnessLufs.toFixed(1)} LUFS (required ${minLufs} to ${maxLufs})`,
  });

  const actual = probe.height > 0 ? probe.width / probe.height : 0;
  const expected = RATIO_VALUE[target.aspectRatio];
  checks.push({
    code: 'aspect_ratio',
    status: Math.abs(actual - expected) / expected <= ASPECT_TOLERANCE ? 'passed' : 'failed',
    severity: 'error',
    detail: `${probe.width}x${probe.height} vs ${target.aspectRatio}`,
  });

  const isMp4 = probe.formatName.split(',').includes('mp4');
  checks.push({
    code: 'codec',
    status: probe.videoCodec === 'h264' && isMp4 ? 'passed' : 'failed',
    severity: 'error',
    detail: `${probe.videoCodec ?? 'none'} (${probe.videoProfile ?? 'unknown profile'}) in ${probe.formatName}`,
  });

  checks.push(evaluateContentSafety(input.contentSafety));

  for (const [code, reason] of [
    ['audio_sync', 'voiceover-to-shot peak alignment analysis not built yet'],
    ['watermark', 'watermark rendering arrives with brand kits'],
    ['caption_sync', 'caption generation (AssemblyAI) not built yet'],
    ['brand_kit', 'brand-kit rendering compliance arrives with brand kits'],
  ] as const) {
    checks.push({ code, status: 'not_run', severity: 'info', detail: reason });
  }
  return checks;
}

export function qualityPassed(checks: QualityCheck[]): boolean {
  return checks.every((c) => c.status !== 'failed');
}

export function hasContentSafetyBlock(checks: QualityCheck[]): boolean {
  return checks.some((c) => c.status === 'failed' && c.severity === 'block');
}

/**
 * The content-safety check flagged a review-level class (not a block). Since 13.17 this pauses
 * the run for a Trust & Safety decision instead of failing it (pipeline/safety-review.ts).
 */
export function contentSafetyReviewCheck(checks: QualityCheck[]): QualityCheck | undefined {
  return checks.find(
    (c) => c.code === 'content_safety' && c.status === 'failed' && c.severity === 'error',
  );
}
