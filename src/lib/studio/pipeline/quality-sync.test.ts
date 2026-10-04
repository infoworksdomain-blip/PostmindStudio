import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CompositionSummary } from './composition-summary';
import { evaluateQuality, qualityPassed } from './quality-checks';
import {
  evaluateAudioSync,
  evaluateBrandKit,
  evaluateCaptionSync,
  evaluateWatermark,
  type BrandExpectation,
} from './quality-sync';
import { pearson, sampleWatermark } from './quality-watermark';

// 15.B2 — spec 13.1 audio_sync, caption_sync, watermark and brand_kit (pass/fail fixtures).

const summary = (over: Partial<CompositionSummary> = {}): CompositionSummary => ({
  version: 1,
  frame: { width: 200, height: 200 },
  totalSec: 6,
  introSec: 0,
  outroSec: 0,
  shots: [
    { shotId: 's1', startSec: 0, lengthSec: 3, treatment: 'AI_CLIP', voiceClipSec: 3 },
    { shotId: 's2', startSec: 3, lengthSec: 3, treatment: 'TEXT_CARD', voiceClipSec: null },
  ],
  brand: {
    logo: true,
    watermark: {
      rect: { x: 10, y: 10, width: 60, height: 60 },
      opacity: 1,
      startSec: 0,
      endSec: 6,
    },
    intro: false,
    outro: false,
    aiLabel: false,
    platformCard: false,
    fontFamily: 'Brandon',
    fontSources: ['https://f/brandon.ttf'],
    textColour: '#ffffff',
    backgroundColour: '#112233',
  },
  ...over,
});

const expected: BrandExpectation = {
  hasKit: true,
  logo: true,
  watermark: true,
  fontFamily: 'Brandon',
  backgroundColour: '#112233',
  textColour: '#FFFFFF',
};

describe('audio_sync', () => {
  it('passes narration that ends inside its shot', () => {
    const check = evaluateAudioSync(summary(), [
      { shotId: 's1', fit: { strategy: 'fits', voiceSec: 2.9, shotSec: 3 } },
    ]);
    expect(check.status).toBe('passed');
  });

  it('fails narration longer than its shot, or cut without word timing', () => {
    expect(
      evaluateAudioSync(summary(), [
        { shotId: 's1', fit: { strategy: 'unmeasured', voiceSec: 4, shotSec: 3 } },
      ]).status,
    ).toBe('failed');
    expect(
      evaluateAudioSync(summary(), [
        {
          shotId: 's1',
          fit: { strategy: 'trim', voiceSec: 4, shotSec: 3, trimSec: 3, wordBoundary: false },
        },
      ]).detail,
    ).toContain('without word timing');
    expect(evaluateAudioSync(summary(), [{ shotId: 's1', fit: null }]).status).toBe('failed');
    expect(
      evaluateAudioSync(summary(), [
        {
          shotId: 's1',
          fit: { strategy: 'trim', voiceSec: 4, shotSec: 3, trimSec: 2.7, wordBoundary: true },
        },
      ]).status,
    ).toBe('passed');
  });

  it('does not run without narration or a summary', () => {
    expect(evaluateAudioSync(null, []).status).toBe('not_run');
    expect(
      evaluateAudioSync(
        summary({
          shots: [
            { shotId: 's', startSec: 0, lengthSec: 3, treatment: 'AI_CLIP', voiceClipSec: null },
          ],
        }),
        [],
      ).status,
    ).toBe('not_run');
  });
});

describe('caption_sync', () => {
  const words = [
    { text: 'Fresh', startSec: 0.2, endSec: 0.6 },
    { text: 'bread', startSec: 0.7, endSec: 1.2 },
  ];
  it('passes captions within ±200ms of their words', () => {
    expect(
      evaluateCaptionSync([
        { overlayId: 'o', text: 'Fresh bread!', startAtSec: 0.1, endAtSec: 1.3, words },
      ]).status,
    ).toBe('passed');
  });
  it('fails drifted captions and captions without timing', () => {
    const drift = evaluateCaptionSync([
      { overlayId: 'o', text: 'Fresh bread', startAtSec: 0.6, endAtSec: 1.2, words },
    ]);
    expect(drift).toMatchObject({ status: 'failed' });
    expect(drift.detail).toContain('400ms');
    expect(
      evaluateCaptionSync([{ overlayId: 'o', text: 'x', startAtSec: 0, endAtSec: 1, words: [] }])
        .status,
    ).toBe('failed');
    expect(
      evaluateCaptionSync([
        { overlayId: 'o', text: 'Other words', startAtSec: 0, endAtSec: 1, words },
      ]).detail,
    ).toContain('not found');
    expect(evaluateCaptionSync([]).status).toBe('not_run');
  });
});

describe('brand_kit', () => {
  it('passes when colours, font and logo are on the timeline', () => {
    expect(evaluateBrandKit(summary(), expected).status).toBe('passed');
  });
  it('is a warning (user review), never a failure, when something is missing', () => {
    const check = evaluateBrandKit(
      summary({ brand: { ...summary().brand, logo: false, fontSources: [] } }),
      expected,
    );
    expect(check).toMatchObject({ status: 'warning', severity: 'info' });
    expect(check.detail).toContain('logo');
    expect(evaluateBrandKit(summary(), { ...expected, hasKit: false }).status).toBe('not_run');
  });
  it('a warning does not fail the gate', () => {
    const checks = evaluateQuality({
      target: { durationSec: 6, aspectRatio: '1:1' },
      probe: {
        durationSec: 6,
        width: 1080,
        height: 1080,
        fps: 30,
        videoCodec: 'h264',
        videoProfile: 'High',
        audioCodec: 'aac',
        formatName: 'mp4',
        bitRateKbps: 1,
      },
      blackIntervals: [],
      loudnessLufs: -14,
      contentSafety: { scan: { framesAnalysed: 1, maxScores: {}, flaggedFrames: [] } as never },
      sync: [evaluateBrandKit(summary({ brand: { ...summary().brand, logo: false } }), expected)],
    });
    expect(checks.find((c) => c.code === 'brand_kit')?.status).toBe('warning');
    expect(checks.some((c) => c.code === 'watermark')).toBe(false);
    expect(qualityPassed(checks)).toBe(true);
  });
});

async function pattern(size: number): Promise<Buffer> {
  // A checkerboard with transparency: the watermark.
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      px.set(on ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * size + x) * 4);
    }
  return sharp(px, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

async function frame(withMark: Buffer | null): Promise<Uint8Array> {
  const noise = Buffer.alloc(200 * 200 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7919) % 251;
  let img = sharp(noise, { raw: { width: 200, height: 200, channels: 3 } });
  if (withMark) {
    const mark = await sharp(withMark).resize(60, 60).png().toBuffer();
    img = sharp(await img.png().toBuffer()).composite([{ input: mark, left: 10, top: 10 }]);
  }
  return new Uint8Array(await img.jpeg({ quality: 95 }).toBuffer());
}

describe('watermark', () => {
  it('passes when the frame sample at the rect matches the watermark', async () => {
    const mark = await pattern(64);
    const withMark = await frame(mark);
    const sample = await sampleWatermark({
      media: { frameJpeg: async () => withMark },
      renderUrl: 'u',
      renderWidth: 200,
      summary: summary(),
      watermarkImage: new Uint8Array(mark),
    });
    expect(sample.status).toBe('visible');
    expect(evaluateWatermark(summary(), expected, sample).status).toBe('passed');
  });

  it('fails when the sampled frames do not show it', async () => {
    const mark = await pattern(64);
    const without = await frame(null);
    const sample = await sampleWatermark({
      media: { frameJpeg: async () => without },
      renderUrl: 'u',
      renderWidth: 200,
      summary: summary(),
      watermarkImage: new Uint8Array(mark),
    });
    expect(sample.status).toBe('not_visible');
    expect(evaluateWatermark(summary(), expected, sample).status).toBe('failed');
  });

  it('fails closed when the timeline misses frames or the sample cannot run', () => {
    const partial = summary({
      brand: {
        ...summary().brand,
        watermark: {
          rect: { x: 0, y: 0, width: 1, height: 1 },
          opacity: 1,
          startSec: 1,
          endSec: 6,
        },
      },
    });
    expect(evaluateWatermark(partial, expected, null).detail).toContain('every content frame');
    expect(
      evaluateWatermark(summary(), expected, { status: 'unavailable', reason: 'ffmpeg missing' })
        .status,
    ).toBe('failed');
    expect(evaluateWatermark(summary(), { ...expected, watermark: false }, null).status).toBe(
      'not_run',
    );
  });

  it('pearson is 1 for identical and 0 for flat input', () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});

describe('caption_sync with a repeated word (production QA run 10, 2026-10-04)', () => {
  const words = [
    { text: 'Ahead', startSec: 0.098, endSec: 0.343 },
    { text: 'AI', startSec: 0.343, endSec: 0.605 },
    { text: 'syncs', startSec: 0.605, endSec: 0.933 },
    { text: 'your', startSec: 0.933, endSec: 1.08 },
    { text: 'calendar', startSec: 1.08, endSec: 1.473 },
    { text: 'and', startSec: 1.506, endSec: 1.572 },
    { text: 'drafts', startSec: 1.654, endSec: 1.916 },
    { text: 'your', startSec: 1.916, endSec: 2.079 },
    { text: 'opener', startSec: 2.145, endSec: 2.325 },
    { text: 'instantly.', startSec: 2.407, endSec: 2.816 },
  ];

  it('matches the occurrence nearest the caption, not the first one', () => {
    const check = evaluateCaptionSync([
      {
        overlayId: 'a',
        text: 'Ahead AI syncs your calendar and drafts',
        startAtSec: 0.098,
        endAtSec: 1.916,
        words,
      },
      { overlayId: 'b', text: 'your opener instantly.', startAtSec: 1.916, endAtSec: 2.816, words },
    ]);
    expect(check.status).toBe('passed');
  });

  it('still fails a caption that really is late', () => {
    const check = evaluateCaptionSync([
      { overlayId: 'b', text: 'your opener instantly.', startAtSec: 2.4, endAtSec: 3.3, words },
    ]);
    expect(check.status).toBe('failed');
  });
});
