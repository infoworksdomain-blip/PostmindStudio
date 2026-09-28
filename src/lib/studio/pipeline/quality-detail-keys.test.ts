import { describe, expect, it } from 'vitest';
import { DETAIL_KEYS } from '../../../components/studio/review/quality-panel';
import { ALL_MESSAGES } from '../../i18n/all-messages';
import { LOCALES } from '../../i18n/locales';
import type { MediaProbe } from './media-probe';
import { evaluateQuality, QUALITY_DETAIL_KEYS, type QualityCheck } from './quality-checks';
import {
  evaluateAudioSync,
  evaluateBrandKit,
  evaluateCaptionSync,
  evaluateWatermark,
} from './quality-sync';

// BACKLOG 17.9 — every quality check carries a stable detail key + parameters that the UI renders
// in the reader's language (review.quality.details.<key>); the English detail stays for logs.

const probe: MediaProbe = {
  durationSec: 15.234,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  videoProfile: 'High',
  audioCodec: 'aac',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitRateKbps: 4_000,
};

function checksWith(overrides: Partial<Parameters<typeof evaluateQuality>[0]> = {}) {
  return evaluateQuality({
    target: { durationSec: 15, aspectRatio: '9:16' },
    probe,
    blackIntervals: [],
    loudnessLufs: -14.04,
    contentSafety: { scan: { framesAnalysed: 30, maxScores: {}, flaggedFrames: [] } },
    ...overrides,
  });
}

const byCode = (checks: QualityCheck[], code: string) => checks.find((c) => c.code === code);

describe('quality detail keys', () => {
  it('the server and the UI know the same keys, and every catalogue has them', () => {
    expect([...QUALITY_DETAIL_KEYS].sort()).toEqual([...DETAIL_KEYS].sort());
    for (const locale of LOCALES) {
      const details = ALL_MESSAGES[locale].review.quality.details as Record<string, string>;
      expect(Object.keys(details).sort()).toEqual([...QUALITY_DETAIL_KEYS].sort());
    }
  });

  it('keys every layer-8 check with rounded numeric parameters', () => {
    const checks = checksWith();
    expect(byCode(checks, 'duration_match')).toMatchObject({
      detailKey: 'duration',
      detailParams: { rendered: 15.23, target: 15, tolerance: 2 },
    });
    expect(byCode(checks, 'black_frames')).toMatchObject({
      detailKey: 'noBlackFrames',
      detailParams: { ms: 500 },
    });
    expect(byCode(checks, 'audio_present')).toMatchObject({
      detailKey: 'loudness',
      detailParams: { lufs: -14, min: -18, max: -10 },
    });
    expect(byCode(checks, 'aspect_ratio')).toMatchObject({
      detailKey: 'aspectRatio',
      detailParams: { width: 1080, height: 1920, target: '9:16' },
    });
    expect(byCode(checks, 'codec')).toMatchObject({ detailKey: 'codec' });
    expect(byCode(checks, 'content_safety')).toMatchObject({
      detailKey: 'safetyPassed',
      detailParams: { count: 30 },
    });
    expect(byCode(checks, 'audio_sync')).toMatchObject({ detailKey: 'audioSyncNotBuilt' });
    for (const check of checks) expect(check.detailKey).toBeDefined();
  });

  it('keys failures, including text from outside Studio as a parameter', () => {
    const checks = checksWith({
      blackIntervals: [{ startSec: 1, endSec: 2.5, durationSec: 1.5 }],
      loudnessLufs: null,
      contentSafety: { unavailable: 'hive is not configured' },
    });
    expect(byCode(checks, 'black_frames')).toMatchObject({
      detailKey: 'blackFrames',
      detailParams: { segments: '1.0–2.5' },
    });
    expect(byCode(checks, 'audio_present')).toMatchObject({ detailKey: 'noAudio' });
    expect(byCode(checks, 'content_safety')).toMatchObject({
      detailKey: 'safetyScanUnavailable',
      detailParams: { reason: 'hive is not configured' },
    });
  });

  it('keys the 15.B2 timeline checks', () => {
    expect(evaluateAudioSync(null, [])).toMatchObject({ detailKey: 'noTimelineSummary' });
    expect(evaluateCaptionSync([])).toMatchObject({ detailKey: 'noSpokenCaptions' });
    const kit = { hasKit: false, logo: false, watermark: false, fontFamily: null };
    expect(evaluateWatermark(null, kit, null)).toMatchObject({ detailKey: 'kitHasNoWatermark' });
    expect(evaluateBrandKit(null, kit)).toMatchObject({ detailKey: 'noBrandKit' });
  });
});
