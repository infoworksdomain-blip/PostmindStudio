import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { extractPalette, paletteFromPixels } from './palette';

function rgba(pixels: Array<[number, number, number, number]>): Uint8Array {
  return new Uint8Array(pixels.flat());
}

describe('paletteFromPixels', () => {
  it('orders colours by frequency, skips transparent pixels and near-white background', () => {
    const pixels: Array<[number, number, number, number]> = [
      ...Array.from({ length: 50 }, () => [255, 255, 255, 255] as [number, number, number, number]),
      ...Array.from({ length: 30 }, () => [198, 69, 45, 255] as [number, number, number, number]),
      ...Array.from({ length: 10 }, () => [43, 29, 20, 255] as [number, number, number, number]),
      ...Array.from({ length: 80 }, () => [0, 255, 0, 0] as [number, number, number, number]),
    ];
    expect(paletteFromPixels(rgba(pixels))).toEqual(['#C6452D', '#2B1D14']);
  });

  it('merges near colours and caps the palette', () => {
    const pixels: Array<[number, number, number, number]> = [
      [200, 70, 45, 255],
      [201, 71, 46, 255],
      [10, 10, 200, 255],
      [10, 200, 10, 255],
      [200, 200, 10, 255],
      [100, 0, 100, 255],
      [0, 0, 0, 255],
    ];
    const palette = paletteFromPixels(rgba(pixels), 3);
    expect(palette).toHaveLength(3);
  });

  it('uses white when the logo is only white', () => {
    expect(paletteFromPixels(rgba([[250, 250, 250, 255]]))).toEqual(['#FAFAFA']);
    expect(paletteFromPixels(rgba([[250, 250, 250, 0]]))).toEqual([]);
  });
});

describe('extractPalette', () => {
  it('reads a PNG logo with sharp', async () => {
    const logo = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 4,
        background: { r: 198, g: 69, b: 45, alpha: 1 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 60, channels: 4, background: '#2B1D14' },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const palette = await extractPalette(new Uint8Array(logo));
    expect(palette[0]).toBe('#C6452D');
    expect(palette).toContain('#2B1D14');
  });

  it('refuses empty files, non-images and SVG', async () => {
    await expect(extractPalette(new Uint8Array())).rejects.toThrow('empty');
    await expect(extractPalette(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('readable image');
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    );
    await expect(extractPalette(svg)).rejects.toThrow('PNG, JPEG');
  });
});
