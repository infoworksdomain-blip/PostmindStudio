import { describe, expect, it } from 'vitest';
import OpengraphImage, { size } from './opengraph-image';
import TwitterImage, { size as twitterSize } from './twitter-image';

// 26.2 — the link-preview image renders (Geist from public/fonts/og) as a 1200×630 PNG, and the
// X card serves the same image.

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('opengraph-image', () => {
  it('returns a 1200×630 PNG', async () => {
    const res = await OpengraphImage();
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    expect(size).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it('is also the twitter-image', () => {
    expect(TwitterImage).toBe(OpengraphImage);
    expect(twitterSize).toEqual(size);
  });
});
