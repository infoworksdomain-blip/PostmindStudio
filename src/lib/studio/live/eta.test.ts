import { describe, expect, it } from 'vitest';
import { estimateLive, etaMinutes, FORMAT_P50_SECONDS, liveFormatOf, liveStageOf } from './eta';

const T0 = Date.parse('2026-10-06T10:00:00Z');

describe('live stage', () => {
  it('maps pipeline states to the chip stages', () => {
    expect(liveStageOf('QUEUED')).toBe('planning');
    expect(liveStageOf('PLANNING')).toBe('planning');
    expect(liveStageOf('ASSETS_GENERATING')).toBe('making_clips');
    expect(liveStageOf('RENDERING')).toBe('composing');
    expect(liveStageOf('QUALITY_CHECKING')).toBe('composing');
    expect(liveStageOf('READY_FOR_REVIEW')).toBe('ready');
    expect(liveStageOf('PUBLISHED')).toBe('posted');
    expect(liveStageOf('FAILED')).toBe('failed');
    expect(liveStageOf('DRAFT')).toBeNull();
    expect(liveStageOf('ARCHIVED')).toBeNull();
  });

  it("uses the publication's state once the post is made, never while it is being remade", () => {
    expect(liveStageOf('APPROVED', 'SCHEDULED')).toBe('scheduled');
    expect(liveStageOf('PUBLISHED', 'FAILED')).toBe('failed');
    expect(liveStageOf('', 'PUBLISHED')).toBe('posted');
    expect(liveStageOf('RENDERING', 'SCHEDULED')).toBe('composing');
  });
});

describe('live format', () => {
  it('reads the format from the source type and the UGC style', () => {
    expect(liveFormatOf({ sourceType: 'CAROUSEL' })).toBe('carousel');
    expect(liveFormatOf({ sourceType: 'WALL_OF_TEXT' })).toBe('wall_of_text');
    expect(liveFormatOf({ sourceType: 'SLIDESHOW' })).toBe('slideshow');
    expect(liveFormatOf({ sourceType: 'HOOK_DEMO' })).toBe('hook_demo');
    expect(liveFormatOf({ sourceType: 'BRIEF', metadata: { ugc: { seed: 1 } } })).toBe('ugc');
    expect(liveFormatOf({ sourceType: 'BRIEF', metadata: null })).toBe('ai_video');
    expect(liveFormatOf({ sourceType: 'UPLOAD' })).toBeNull();
  });

  it('keeps the p50 constants measured on production 2026-10-06', () => {
    expect(FORMAT_P50_SECONDS).toEqual({
      carousel: 26,
      wall_of_text: 81,
      slideshow: 112,
      hook_demo: 135,
      ugc: 230,
      ai_video: 431,
    });
  });
});

describe('estimateLive', () => {
  it('counts down from the format p50 since the run started', () => {
    const e = estimateLive({
      stage: 'making_clips',
      format: 'ai_video',
      startedAtMs: T0,
      nowMs: T0 + 120_000,
    });
    expect(e.etaSec).toBe(431 - 120);
    expect(e.progressPct).toBe(Math.round((120 / 431) * 100));
    expect(etaMinutes(e.etaSec ?? 0)).toBe(6);
  });

  it("keeps progress inside the stage's band", () => {
    const early = estimateLive({
      stage: 'composing',
      format: 'slideshow',
      startedAtMs: T0,
      nowMs: T0 + 1_000,
    });
    expect(early.progressPct).toBe(80);
    expect(early.etaSec).toBeLessThanOrEqual(Math.round(112 * 0.2));
    const late = estimateLive({
      stage: 'planning',
      format: 'carousel',
      startedAtMs: T0,
      nowMs: T0 + 600_000,
    });
    expect(late.progressPct).toBe(20);
    expect(late.etaSec).toBe(0);
  });

  it('estimates from the stage when the start is unknown', () => {
    const e = estimateLive({ stage: 'planning', format: 'ugc', startedAtMs: null, nowMs: T0 });
    expect(e.progressPct).toBe(2);
    expect(e.etaSec).toBe(Math.round(230 * 0.98));
  });

  it('has no estimate for made posts or formats without a p50', () => {
    expect(
      estimateLive({ stage: 'ready', format: 'carousel', startedAtMs: T0, nowMs: T0 }),
    ).toEqual({ progressPct: null, etaSec: null });
    expect(estimateLive({ stage: 'planning', format: null, startedAtMs: T0, nowMs: T0 })).toEqual({
      progressPct: null,
      etaSec: null,
    });
  });

  it('shows at least one minute while time is left', () => {
    expect(etaMinutes(5)).toBe(1);
    expect(etaMinutes(61)).toBe(2);
  });
});
