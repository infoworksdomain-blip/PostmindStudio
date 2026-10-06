import { describe, expect, it, vi } from 'vitest';
import type { MediaInspector } from './media-probe';
import {
  combineCrop,
  cropdetectFilter,
  detectLetterbox,
  hasBars,
  letterboxFromBounds,
  letterboxMeasured,
  letterboxOf,
  NO_CROP,
  parseCropdetect,
  visibleAspect,
} from './letterbox';

// 22.6 — black bars baked into a clip (production QA 2026-10-06: a Veo 720×1280 hook clip with
// a ~10 % band across the top).

const VEO = { width: 720, height: 1280 };

describe('parseCropdetect', () => {
  it('reads the LAST line (the area across every frame seen)', () => {
    const stderr = [
      'Input #0, mov,mp4 …',
      '[Parsed_cropdetect_1 @ 0x55d] x1:0 x2:719 y1:140 y2:1279 w:720 h:1140 x:0 y:140 pts:0 t:0.000000 limit:0.094118 crop=720:1140:0:140',
      '[Parsed_cropdetect_1 @ 0x55d] x1:0 x2:719 y1:128 y2:1279 w:720 h:1152 x:0 y:128 pts:15360 t:0.500000 limit:0.094118 crop=720:1152:0:128',
    ].join('\n');
    expect(parseCropdetect(stderr)).toEqual({ x1: 0, x2: 719, y1: 128, y2: 1279 });
  });

  it('gives null when cropdetect printed nothing', () => {
    expect(parseCropdetect('frame=  0 fps=0.0 q=0.0 Lsize=N/A')).toBeNull();
  });

  it('samples a few frames a second and evaluates every one', () => {
    expect(cropdetectFilter()).toBe('fps=2,cropdetect=limit=24:round=2:skip=0');
  });
});

describe('letterboxFromBounds', () => {
  it('turns a 128 px top band into a relative top crop (with a small edge margin)', () => {
    const crop = letterboxFromBounds({ x1: 0, x2: 719, y1: 128, y2: 1279 }, VEO);
    expect(crop).toEqual({ top: 0.105, bottom: 0, left: 0, right: 0 });
  });

  it('ignores bars under 2 % of the side', () => {
    const crop = letterboxFromBounds({ x1: 6, x2: 713, y1: 20, y2: 1259 }, VEO);
    expect(crop).toEqual(NO_CROP);
    expect(hasBars(crop)).toBe(false);
  });

  it('reads top + bottom and side bars', () => {
    const crop = letterboxFromBounds({ x1: 40, x2: 679, y1: 64, y2: 1215 }, VEO);
    expect(crop).toEqual({ top: 0.055, bottom: 0.055, left: 0.0606, right: 0.0606 });
  });

  it('does not crop a dark scene (a "bar" over 30 %) or an all-black sample', () => {
    expect(letterboxFromBounds({ x1: 0, x2: 719, y1: 500, y2: 1279 }, VEO)).toBeNull();
    expect(letterboxFromBounds({ x1: 719, x2: 0, y1: 1279, y2: 0 }, VEO)).toBeNull();
  });
});

describe('letterboxOf / letterboxMeasured', () => {
  it('reads recorded bars and treats no-bars as measured but nothing to crop', () => {
    expect(letterboxOf({ letterbox: { top: 0.1, bottom: 0, left: 0, right: 0 } })).toEqual({
      top: 0.1,
      bottom: 0,
      left: 0,
      right: 0,
    });
    expect(letterboxOf({ letterbox: NO_CROP })).toBeNull();
    expect(letterboxMeasured({ letterbox: NO_CROP })).toBe(true);
    expect(letterboxMeasured({ other: 1 })).toBe(false);
    expect(letterboxOf({ letterbox: { top: 'x', bottom: 2 } })).toBeNull();
  });
});

describe('combineCrop / visibleAspect', () => {
  it('cuts the inner crop from the picture left inside the bars', () => {
    const bars = { top: 0.1, bottom: 0, left: 0, right: 0 };
    expect(combineCrop(bars, { top: 0.25, bottom: 0.25, left: 0, right: 0 })).toEqual({
      top: 0.325,
      bottom: 0.225,
      left: 0,
      right: 0,
    });
    expect(combineCrop(null, NO_CROP)).toEqual(NO_CROP);
    expect(visibleAspect(0.5625, bars)).toBeCloseTo(0.625, 4);
  });
});

describe('detectLetterbox', () => {
  const log = { warn: vi.fn() };

  it('measures through the inspector', async () => {
    const media = {
      cropBounds: vi.fn(async () => ({
        bounds: { x1: 0, x2: 719, y1: 128, y2: 1279 },
        frame: VEO,
      })),
    } as unknown as MediaInspector;
    await expect(detectLetterbox(media, async () => 'https://x/clip.mp4', log)).resolves.toEqual({
      top: 0.105,
      bottom: 0,
      left: 0,
      right: 0,
    });
  });

  it('never throws: a detection error is logged and the clip stays uncropped', async () => {
    const media = {
      cropBounds: vi.fn(async () => {
        throw new Error('ffmpeg not found');
      }),
    } as unknown as MediaInspector;
    await expect(detectLetterbox(media, async () => 'u', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    const signing = { cropBounds: vi.fn() } as unknown as MediaInspector;
    await expect(
      detectLetterbox(
        signing,
        async () => {
          throw new Error('no signer');
        },
        log,
      ),
    ).resolves.toBeUndefined();
  });

  it('skips inspectors without cropdetect and reports "measured, no bars" when none printed', async () => {
    await expect(
      detectLetterbox({} as MediaInspector, async () => 'u', log),
    ).resolves.toBeUndefined();
    const silent = { cropBounds: vi.fn(async () => null) } as unknown as MediaInspector;
    await expect(detectLetterbox(silent, async () => 'u', log)).resolves.toEqual(NO_CROP);
  });
});
