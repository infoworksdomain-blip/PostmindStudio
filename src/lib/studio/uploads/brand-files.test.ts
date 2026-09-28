import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fakeTtf } from '../../../../test/helpers/fake-font';
import { parseFontFamily, parseImage, parseJpeg, parsePng } from './brand-files';

// 15.B1 — byte-level checks for brand uploads.

describe('brand file parsing', () => {
  it('reads PNG size and transparency', async () => {
    const rgba = await sharp({
      create: { width: 120, height: 80, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    expect(parsePng(new Uint8Array(rgba))).toEqual({
      format: 'png',
      width: 120,
      height: 80,
      hasAlpha: true,
    });
    const rgb = await sharp({ create: { width: 90, height: 90, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    expect(parsePng(new Uint8Array(rgb))?.hasAlpha).toBe(false);
    expect(parsePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('reads JPEG frame size', async () => {
    const jpg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#000' },
    })
      .jpeg()
      .toBuffer();
    expect(parseJpeg(new Uint8Array(jpg))).toEqual({
      format: 'jpeg',
      width: 300,
      height: 200,
      hasAlpha: false,
    });
    expect(parseImage(new Uint8Array(jpg))?.format).toBe('jpeg');
    expect(parseImage(new Uint8Array([0, 0]))).toBeNull();
  });

  it('reads the embedded font family, preferring the typographic family', () => {
    expect(parseFontFamily(fakeTtf('Brandon Grotesque'))).toBe('Brandon Grotesque');
    expect(parseFontFamily(fakeTtf('Typo', 16))).toBe('Typo');
    expect(parseFontFamily(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
