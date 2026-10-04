import type { QualityCheck } from './quality-checks';
import type { CompositionSummary } from './composition-summary';
import type { FitDecision } from './voice-fit';
import { FIT_SLACK_SEC, FIT_TOLERANCE } from './voice-fit';
import { normaliseWord, type SpokenWord } from '../overlays/word-timing';

// BACKLOG 15.B2 — the four §13.1 checks that were recorded as `not_run`:
//   - audio_sync "Voiceover peaks align to shot boundaries": every narration clip on the timeline
//     ends inside its shot (±5%, spec 5.5) and is never cut mid-word (15.B3 fit decisions);
//   - caption_sync "Captions align to voiceover ±200ms": spoken captions (narration captions and
//     karaoke overlays; never headline/title/CTA text, 20.22 overlays/kind.ts) start and end
//     within 200 ms of the words they show (13.6 word timings);
//   - watermark "Watermark visible in required frames": the kit's watermark covers every content
//     frame on the timeline, and a frame sample at its rect matches the watermark image;
//   - brand_kit "Colours, fonts, logo present": the kit's logo, font and palette are on the
//     timeline. Failure action per §13.1 is "User review required": status `warning`, which does
//     not fail the gate but keeps the video from auto-approval.
// Failure actions per §13.1: audio_sync → regenerate voice, caption_sync → regenerate captions,
// watermark → re-render composition (all force-approvable `error`s).

export const CAPTION_SYNC_TOLERANCE_SEC = 0.2;

/** A slideshow has no timeline summary: the timeline checks do not apply. */
const NO_SUMMARY: Omit<QualityCheck, 'code'> = {
  status: 'not_run',
  severity: 'info',
  detail: 'no timeline summary (slideshow)',
  detailKey: 'noTimelineSummary',
};

export interface NarrationFact {
  shotId: string;
  fit: FitDecision | null;
}

export function evaluateAudioSync(
  summary: CompositionSummary | null,
  narration: NarrationFact[],
): QualityCheck {
  const code = 'audio_sync';
  if (!summary) return { ...NO_SUMMARY, code };
  const voiced = summary.shots.filter((s) => s.voiceClipSec !== null && s.shotId);
  if (voiced.length === 0)
    return {
      code,
      status: 'not_run',
      severity: 'info',
      detail: 'no narration on the timeline',
      detailKey: 'noNarration',
    };
  const fits = new Map(narration.map((n) => [n.shotId, n.fit]));
  const problems: string[] = [];
  const badShots: number[] = [];
  voiced.forEach((shot) => {
    const fit = fits.get(shot.shotId as string) ?? null;
    const number = summary.shots.indexOf(shot) + 1;
    const problem = (text: string) => {
      problems.push(`shot ${number}: ${text}`);
      badShots.push(number);
    };
    if (!fit || fit.voiceSec === null) {
      problem('narration length unknown');
      return;
    }
    const clip = shot.voiceClipSec ?? 0;
    if (fit.strategy === 'trim') {
      if (!fit.wordBoundary) problem('narration cut without word timing');
      return;
    }
    if (fit.voiceSec > shot.lengthSec * (1 + FIT_TOLERANCE) || fit.voiceSec > clip + FIT_SLACK_SEC)
      problem(`${fit.voiceSec.toFixed(2)}s of narration in a ${shot.lengthSec.toFixed(2)}s shot`);
  });
  return problems.length
    ? {
        code,
        status: 'failed',
        severity: 'error',
        detail: problems.join('; '),
        detailKey: 'audioSyncFailed',
        detailParams: { count: badShots.length, shots: badShots.join(', ') },
      }
    : {
        code,
        status: 'passed',
        severity: 'info',
        detail: `${voiced.length} narrated shot(s) end inside their shots`,
        detailKey: 'audioSyncPassed',
        detailParams: { count: voiced.length },
      };
}

export interface SpokenCaption {
  overlayId: string;
  text: string;
  /** Seconds from the shot start. */
  startAtSec: number;
  endAtSec: number;
  /** Spoken words of the shot (from the shot start); empty when there is no word timing. */
  words: SpokenWord[];
}

/** First/last overlay words matched in order to the spoken words, or null. */
export function matchCaption(
  caption: SpokenCaption,
): { first: SpokenWord; last: SpokenWord } | null {
  const keys = caption.text.split(/\s+/).map(normaliseWord).filter(Boolean);
  if (keys.length === 0) return null;
  const window = caption.words.filter(
    (w) => w.endSec > caption.startAtSec - 1 && w.startSec < caption.endAtSec + 1,
  );
  const firstIdx = window.findIndex((w) => normaliseWord(w.text) === keys[0]);
  if (firstIdx < 0) return null;
  let lastIdx = -1;
  for (let j = window.length - 1; j >= firstIdx; j -= 1) {
    if (normaliseWord(window[j]?.text ?? '') === keys.at(-1)) {
      lastIdx = j;
      break;
    }
  }
  if (lastIdx < 0) return null;
  return { first: window[firstIdx] as SpokenWord, last: window[lastIdx] as SpokenWord };
}

export function evaluateCaptionSync(captions: SpokenCaption[]): QualityCheck {
  const code = 'caption_sync';
  if (captions.length === 0)
    return {
      code,
      status: 'not_run',
      severity: 'info',
      detail: 'no spoken captions on the video',
      detailKey: 'noSpokenCaptions',
    };
  const problems: string[] = [];
  for (const c of captions) {
    if (c.words.length === 0) {
      problems.push(`"${c.text.slice(0, 30)}": no word timing for its narration`);
      continue;
    }
    const match = matchCaption(c);
    if (!match) {
      problems.push(`"${c.text.slice(0, 30)}": words not found in the narration`);
      continue;
    }
    const startDrift = Math.abs(c.startAtSec - match.first.startSec);
    const endDrift = Math.abs(c.endAtSec - match.last.endSec);
    if (startDrift > CAPTION_SYNC_TOLERANCE_SEC || endDrift > CAPTION_SYNC_TOLERANCE_SEC)
      problems.push(
        `"${c.text.slice(0, 30)}": off by ${Math.round(Math.max(startDrift, endDrift) * 1000)}ms`,
      );
  }
  return problems.length
    ? {
        code,
        status: 'failed',
        severity: 'error',
        detail: problems.slice(0, 5).join('; '),
        detailKey: 'captionSyncFailed',
        detailParams: { count: problems.length },
      }
    : {
        code,
        status: 'passed',
        severity: 'info',
        detail: `${captions.length} caption(s) within ±${CAPTION_SYNC_TOLERANCE_SEC * 1000}ms`,
        detailKey: 'captionSyncPassed',
        detailParams: { count: captions.length, ms: CAPTION_SYNC_TOLERANCE_SEC * 1000 },
      };
}

export interface BrandExpectation {
  hasKit: boolean;
  logo: boolean;
  watermark: boolean;
  /** Expected Latin font family (null = none set). */
  fontFamily: string | null;
  /** Kit palette colours 1–2 (background, text), when set. */
  backgroundColour?: string;
  textColour?: string;
}

/** Frame-sample result for the watermark rect (quality-watermark.ts). */
export type WatermarkSample =
  | { status: 'visible'; scores: number[] }
  | { status: 'not_visible'; scores: number[] }
  | { status: 'unavailable'; reason: string };

export function evaluateWatermark(
  summary: CompositionSummary | null,
  expected: BrandExpectation,
  sample: WatermarkSample | null,
): QualityCheck {
  const code = 'watermark';
  if (!expected.watermark)
    return {
      code,
      status: 'not_run',
      severity: 'info',
      detail: 'the brand kit has no watermark',
      detailKey: 'kitHasNoWatermark',
    };
  if (!summary)
    return {
      code,
      status: 'not_run',
      severity: 'info',
      detail: 'slideshows carry no brand watermark',
      detailKey: 'slideshowNoWatermark',
    };
  const mark = summary.brand.watermark;
  const contentStart = summary.introSec;
  const contentEnd = summary.totalSec - summary.outroSec;
  if (!mark || mark.startSec > contentStart + 0.01 || mark.endSec < contentEnd - 0.01)
    return {
      code,
      status: 'failed',
      severity: 'error',
      detail: 'the watermark does not cover every content frame of the timeline',
      detailKey: 'watermarkNotCovering',
    };
  if (!sample || sample.status === 'unavailable')
    return {
      code,
      status: 'failed',
      severity: 'error',
      detail: `frame sample could not run: ${sample?.reason ?? 'no sampler'}`,
      detailKey: 'watermarkSampleUnavailable',
      detailParams: { reason: sample?.reason ?? 'no sampler' },
    };
  const scores = sample.scores.map((s) => s.toFixed(2)).join(', ');
  return sample.status === 'visible'
    ? {
        code,
        status: 'passed',
        severity: 'info',
        detail: `on the timeline; sampled ${scores}`,
        detailKey: 'watermarkVisible',
        detailParams: { scores },
      }
    : {
        code,
        status: 'failed',
        severity: 'error',
        detail: `on the timeline but not visible in sampled frames (${scores})`,
        detailKey: 'watermarkNotVisible',
        detailParams: { scores },
      };
}

export function evaluateBrandKit(
  summary: CompositionSummary | null,
  expected: BrandExpectation,
): QualityCheck {
  const code = 'brand_kit';
  if (!expected.hasKit)
    return {
      code,
      status: 'not_run',
      severity: 'info',
      detail: 'the project has no brand kit',
      detailKey: 'noBrandKit',
    };
  if (!summary) return { ...NO_SUMMARY, code };
  const missing: string[] = [];
  if (expected.logo && !summary.brand.logo) missing.push('logo');
  if (expected.fontFamily && summary.brand.fontFamily !== expected.fontFamily)
    missing.push(`font ${expected.fontFamily}`);
  if (expected.fontFamily && summary.brand.fontSources.length === 0)
    missing.push('font file (no timeline.fonts source)');
  if (
    expected.backgroundColour &&
    summary.brand.backgroundColour.toLowerCase() !== expected.backgroundColour.toLowerCase()
  )
    missing.push('background colour');
  if (
    expected.textColour &&
    summary.brand.textColour.toLowerCase() !== expected.textColour.toLowerCase()
  )
    missing.push('text colour');
  return missing.length
    ? {
        code,
        status: 'warning',
        severity: 'info',
        detail: `review needed — not on the timeline: ${missing.join(', ')}`,
        detailKey: 'brandKitMissing',
        detailParams: { count: missing.length },
      }
    : {
        code,
        status: 'passed',
        severity: 'info',
        detail: 'colours, fonts and logo present',
        detailKey: 'brandKitPresent',
      };
}
