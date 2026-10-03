import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  BLACKDETECT_PICTURE_THRESHOLD,
  BLACKDETECT_PIXEL_THRESHOLD,
  blackdetectFilter,
  parseBlackdetect,
  PREVIEW_FILE,
  previewClipArgs,
} from './media-probe';
import { BLACK_FRAME_MAX_SEC } from './quality-checks';

// BACKLOG 20.17 — library previews keep their sound (operator decision 2026-10-01). The real
// ffmpeg run (with and without an audio stream) is covered in test/media/scenes.test.ts.

describe('previewClipArgs', () => {
  const args = previewClipArgs('https://bucket.test/library/abc.mp4?sig=1', 360, 30);

  function valueAfter(flag: string): string | undefined {
    return args[args.indexOf(flag) + 1];
  }

  it('encodes the audio as AAC stereo at a modest bitrate and never drops it', () => {
    expect(args).not.toContain('-an');
    expect(valueAfter('-c:a')).toBe('aac');
    expect(valueAfter('-b:a')).toBe('96k');
    expect(valueAfter('-ac')).toBe('2');
  });

  it('maps the first video stream and the first audio stream only when there is one', () => {
    const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:v:0', '0:a:0?']);
  });

  it('keeps the A3.10 limits: 360 px wide at most, 30 s at most, faststart MP4', () => {
    expect(valueAfter('-i')).toBe('https://bucket.test/library/abc.mp4?sig=1');
    expect(valueAfter('-t')).toBe('30.000');
    expect(valueAfter('-vf')).toBe("scale='min(360,iw)':-2,fps=15");
    expect(valueAfter('-c:v')).toBe('libx264');
    expect(valueAfter('-movflags')).toBe('+faststart');
    expect(args.at(-1)).toBe(PREVIEW_FILE);
  });
});

// BACKLOG 20.22 — blackdetect thresholds and parsing (QA run 3's QUALITY_FAILED).
describe('blackdetect', () => {
  it('pins both thresholds and the minimum duration in the filter', () => {
    expect(blackdetectFilter(BLACK_FRAME_MAX_SEC)).toBe('blackdetect=d=0.5:pix_th=0.1:pic_th=0.98');
    expect(BLACKDETECT_PIXEL_THRESHOLD).toBe(0.1);
    expect(BLACKDETECT_PICTURE_THRESHOLD).toBe(0.98);
  });

  it('refuses a non-positive or non-finite duration', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => blackdetectFilter(bad)).toThrow(ValidationError);
  });

  it('parses ffmpeg 5.1 stderr, including an interval that runs to the end of the file', () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'render.mp4':",
      '[blackdetect @ 0x55d1c3a1e040] black_start:7.2 black_end:8 black_duration:0.8',
      'frame=  900 fps=450 q=-0.0 size=N/A time=00:00:30.00 bitrate=N/A speed=15x',
      '[blackdetect @ 0x55d1c3a1e040] black_start:25.7667 black_end:26.3 black_duration:0.533333',
      '[blackdetect @ 0x55d1c3a1e040] black_start:27.7 black_end:30 black_duration:2.3',
    ].join('\n');
    expect(parseBlackdetect(stderr)).toEqual([
      { startSec: 7.2, endSec: 8, durationSec: 0.8 },
      { startSec: 25.7667, endSec: 26.3, durationSec: 0.533333 },
      { startSec: 27.7, endSec: 30, durationSec: 2.3 },
    ]);
  });

  it('reads %g exponent times and Windows line endings', () => {
    const stderr =
      '[blackdetect @ 0x1] black_start:0 black_end:1e-05 black_duration:1e-05\r\n' +
      '[blackdetect @ 0x1] black_start:1.5e+01 black_end:16 black_duration:1\r\n';
    expect(parseBlackdetect(stderr)).toEqual([
      { startSec: 0, endSec: 0.00001, durationSec: 0.00001 },
      { startSec: 15, endSec: 16, durationSec: 1 },
    ]);
  });

  it('returns nothing for a clean render', () => {
    expect(parseBlackdetect('frame= 900 fps=450 time=00:00:30.00\n')).toEqual([]);
  });
});
