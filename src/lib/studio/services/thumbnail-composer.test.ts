import { describe, expect, it } from 'vitest';
import { thumbnailFilter, thumbnailSize, wrapText } from './thumbnail-composer';
import { imageTypeOf } from './thumbnails';

describe('thumbnail composer (15.A3)', () => {
  it('sizes thumbnails per aspect ratio', () => {
    expect(thumbnailSize('16:9')).toEqual({ width: 1280, height: 720 });
    expect(thumbnailSize('9:16')).toEqual({ width: 720, height: 1280 });
    expect(thumbnailSize('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(thumbnailSize('4:5')).toEqual({ width: 1080, height: 1350 });
  });

  it('wraps overlay text into at most three short lines', () => {
    expect(wrapText('3 tips for better sourdough at home this weekend and beyond forever')).toBe(
      '3 tips for better\nsourdough at home this\nweekend and beyond',
    );
    expect(wrapText('  Hi  ')).toBe('Hi');
  });

  it('builds a keyframe-over-library filter with text from a file (no user text inline)', () => {
    const f = thumbnailFilter({
      width: 1280,
      height: 720,
      withBackground: true,
      withText: true,
      withFont: true,
    });
    expect(f).toContain('[1:v]scale=1280:720:force_original_aspect_ratio=increase');
    expect(f).toContain('boxblur');
    expect(f).toContain('[bg][kf]overlay');
    expect(f).toContain('drawtext=textfile=text.txt:fontfile=font.ttf');
    expect(f.endsWith('[out]')).toBe(true);
  });

  it('uses the keyframe alone without a library image or text', () => {
    const f = thumbnailFilter({
      width: 720,
      height: 1280,
      withBackground: false,
      withText: false,
      withFont: false,
    });
    expect(f).toBe(
      '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1[base];[base]null[out]',
    );
  });

  it('detects JPEG and PNG by magic bytes only', () => {
    expect(imageTypeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageTypeOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(imageTypeOf(new TextEncoder().encode('<svg/>'))).toBeNull();
  });
});
