import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dHash, hammingDistance, nearestWithin, tryDHash } from './phash';

// A synthetic "photo": a diagonal gradient with a block, so the hash has structure.
async function picture(width: number, height: number, variant = 0): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const block = x > width * 0.3 && x < width * 0.6 && y > height * 0.2 && y < height * 0.5;
      const base = variant === 0 ? (x / width) * 200 + (y / height) * 55 : (1 - x / width) * 255;
      data[i] = block ? 30 : base;
      data[i + 1] = block ? 200 : base * 0.8;
      data[i + 2] = block ? 90 : 255 - base;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

describe('dHash', () => {
  it('is 16 hex characters and stable', async () => {
    const png = await picture(800, 600);
    const a = await dHash(png);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await dHash(png)).toBe(a);
  });

  it('a resized, re-encoded copy is a near-duplicate; a different picture is not', async () => {
    const original = await picture(1200, 900);
    const copy = await sharp(original).resize(600, 450).jpeg({ quality: 70 }).toBuffer();
    const other = await picture(1200, 900, 1);
    const [h1, h2, h3] = await Promise.all([dHash(original), dHash(copy), dHash(other)]);
    expect(hammingDistance(h1, h2)).toBeLessThanOrEqual(6);
    expect(hammingDistance(h1, h3)).toBeGreaterThan(6);
  });

  it('tryDHash returns null for bytes that are not an image', async () => {
    expect(await tryDHash(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('hammingDistance / nearestWithin', () => {
  it('counts differing bits; malformed hashes never match', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('000000000000000f', '0000000000000000')).toBe(4);
    expect(hammingDistance('xyz', '0000000000000000')).toBe(Number.POSITIVE_INFINITY);
  });

  it('picks the closest candidate within the threshold', () => {
    const candidates = [
      { id: 'far', phash: 'ffffffffffffffff' },
      { id: 'none', phash: null },
      { id: 'near', phash: '0000000000000003' },
      { id: 'nearest', phash: '0000000000000001' },
    ];
    expect(nearestWithin('0000000000000000', candidates)?.item.id).toBe('nearest');
    expect(nearestWithin('00000000000000ff', candidates, 6)?.item.id).toBe('near');
    expect(nearestWithin('0f0f0f0f0f0f0f0f', candidates)).toBeNull();
  });
});
