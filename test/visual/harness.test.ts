import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { BUILT_IN_PRESETS } from '../../src/lib/studio/overlays/presets';
import {
  diffRatio,
  FRAME,
  fontFileName,
  maxDiffRatio,
  pngDiffRatio,
  presetCases,
  previewHtml,
  visualEnv,
} from './harness';

// BACKLOG 15.D10 — the pixel-diff harness itself (always runs; no ffmpeg / browser needed).

describe('presetCases', () => {
  it('covers every built-in preset (A14.2: at least the 25) with a settled 0–2 s overlay', () => {
    const cases = presetCases();
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(new Set(cases.map((c) => c.key)).size).toBe(BUILT_IN_PRESETS.length);
    expect(cases.map((c) => c.key)).toEqual(BUILT_IN_PRESETS.map((p) => p.key));
    for (const c of cases) {
      expect(c.row.endAtSec - c.row.startAtSec).toBe(2);
      expect(c.preview.fontFamily).toBe(c.row.fontFamily);
      expect(c.preview.fillColor).toBe(c.row.fillColor);
    }
    // karaoke / counter presets are the ones production pre-renders with FFmpeg.
    expect(cases.filter((c) => c.preRendered).map((c) => c.key)).toEqual(
      expect.arrayContaining(['subtitle_karaoke', 'stat_ticker_roll', 'stat_count_up']),
    );
  });

  it('names font files the way the pre-render fetches them', () => {
    expect(fontFileName('Bebas Neue')).toBe('BebasNeue.ttf');
  });
});

describe('previewHtml', () => {
  it('renders the editor overlay style in a frame of the harness size with the font inlined', () => {
    const [first] = presetCases();
    const html = previewHtml(first!.preview, FRAME, 'data:font/ttf;base64,AAAA');
    expect(html).toContain('id="frame"');
    expect(html).toContain('width:540px');
    expect(html).toContain('container-type:size');
    expect(html).toContain('Save 42% today');
    expect(html).toContain('src: url(data:font/ttf;base64,AAAA)');
  });
});

describe('diffRatio / pngDiffRatio', () => {
  it('counts pixels over the channel tolerance', () => {
    const a = new Uint8Array([0, 0, 0, 10, 10, 10]);
    expect(diffRatio(a, new Uint8Array([0, 0, 0, 10, 10, 10]), 3)).toBe(0);
    expect(diffRatio(a, new Uint8Array([0, 0, 200, 10, 10, 10]), 3)).toBe(0.5);
    expect(diffRatio(a, new Uint8Array([40, 0, 0, 10, 10, 10]), 3)).toBe(0);
    expect(() => diffRatio(a, new Uint8Array(3), 3)).toThrow(RangeError);
  });

  it('flattens transparency onto black before comparing', async () => {
    const png = (r: number, alpha: number) =>
      sharp({
        create: { width: 4, height: 4, channels: 4, background: { r, g: 0, b: 0, alpha } },
      })
        .png()
        .toBuffer();
    const size = { width: 4, height: 4 };
    expect(await pngDiffRatio(await png(255, 0), await png(0, 1), size)).toBe(0);
    expect(await pngDiffRatio(await png(255, 1), await png(0, 1), size)).toBe(1);
  });

  it('reads the tolerance from VISUAL_MAX_DIFF_RATIO', () => {
    expect(maxDiffRatio({})).toBe(0.02);
    expect(maxDiffRatio({ VISUAL_MAX_DIFF_RATIO: '0.05' })).toBe(0.05);
    expect(maxDiffRatio({ VISUAL_MAX_DIFF_RATIO: 'x' })).toBe(0.02);
  });
});

describe('visualEnv', () => {
  it('explains why it skips when a tool is missing', async () => {
    const result = await visualEnv({ FFMPEG_PATH: 'definitely-not-ffmpeg-15d10' });
    expect(result).toEqual({ skip: expect.stringContaining('ffmpeg is not installed') });
  });
});
