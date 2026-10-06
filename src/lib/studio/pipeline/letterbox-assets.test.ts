import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { clipLetterboxes } from './letterbox-assets';
import type { PipelineDeps } from './deps';

// 22.6 — clips stored without a measurement (library footage, demo uploads, older assets) are
// measured the first time they are composed, and the result is kept on the asset.

const BOUNDS = {
  bounds: { x1: 0, x2: 719, y1: 128, y2: 1279 },
  frame: { width: 720, height: 1280 },
};

function deps(cropBounds: () => Promise<typeof BOUNDS | null>) {
  const update = vi.fn(async () => ({}));
  return {
    update,
    cropBounds: vi.fn(cropBounds),
    deps: {
      db: { videoAsset: { update } },
      media: { cropBounds: vi.fn(cropBounds) },
      storage: { signedUrl: vi.fn(async () => 'https://s3.test/clip.mp4') },
      logger: { warn: vi.fn() },
    } as unknown as Pick<PipelineDeps, 'db' | 'media' | 'storage' | 'logger'>,
  };
}

const asset = (id: string, metadata: Prisma.JsonValue, kind = 'VIDEO_CLIP' as const) => ({
  id,
  kind,
  s3Bucket: 'b',
  s3Key: `${id}.mp4`,
  metadata,
});

describe('clipLetterboxes', () => {
  it('uses recorded bars without measuring again', async () => {
    const d = deps(async () => BOUNDS);
    const bars = await clipLetterboxes(d.deps, [
      asset('veo', { letterbox: { top: 0.105, bottom: 0, left: 0, right: 0 } }),
      asset('clean', { letterbox: { top: 0, bottom: 0, left: 0, right: 0 } }),
    ]);
    expect([...bars.keys()]).toEqual(['veo']);
    expect(d.deps.media.cropBounds).not.toHaveBeenCalled();
  });

  it('measures an unmeasured clip once and keeps the result on the asset', async () => {
    const d = deps(async () => BOUNDS);
    const bars = await clipLetterboxes(d.deps, [asset('library', { licenceMode: 'FOOTAGE' })]);
    expect(bars.get('library')).toEqual({ top: 0.105, bottom: 0, left: 0, right: 0 });
    expect(d.update).toHaveBeenCalledWith({
      where: { id: 'library' },
      data: {
        metadata: {
          licenceMode: 'FOOTAGE',
          letterbox: { top: 0.105, bottom: 0, left: 0, right: 0 },
        },
      },
    });
  });

  it('skips images and never fails the render on a detection error', async () => {
    const d = deps(async () => {
      throw new Error('ffmpeg missing');
    });
    const image = { ...asset('img', null), kind: 'IMAGE' as const };
    const bars = await clipLetterboxes(d.deps, [image, asset('clip', null)]);
    expect(bars.size).toBe(0);
    expect(d.update).not.toHaveBeenCalled();
    expect(d.deps.logger.warn).toHaveBeenCalled();
  });
});
