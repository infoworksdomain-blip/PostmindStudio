import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';
import {
  decodeMediaCursor,
  encodeMediaCursor,
  listMedia,
  listMediaQuery,
  type MediaDeps,
} from './media';

// 25.10 — the media feed's cursor and merge, without a database (test/api/media.test.ts covers
// the queries on Postgres).

const T = new Date('2026-10-07T10:00:00.000Z');

function fakeDeps(over: Partial<MediaDeps> = {}) {
  const renders = vi.fn(async () => [
    {
      id: 'r_b',
      targetPlatform: 'tiktok',
      aspectRatio: '9:16',
      resolution: '1080x1920',
      durationSec: 20,
      thumbnailS3Key: null,
      createdAt: T,
      project: { id: 'p1', name: null, state: 'APPROVED', businessId: 'biz' },
    },
  ]);
  const uploads = vi.fn(async () => [
    {
      id: 'u_c',
      kind: 'DEMO_VIDEO',
      businessId: 'biz',
      projectId: null,
      fileName: 'demo.mp4',
      widthPx: null,
      heightPx: null,
      durationSec: 9,
      sizeBytes: BigInt(42),
      createdAt: T,
      s3Bucket: 'b',
      s3Key: 'k',
    },
  ]);
  const images = vi.fn(async () => []);
  const deps = {
    db: {
      videoRender: { findMany: renders },
      videoUpload: { findMany: uploads },
      imageLibraryItem: { findMany: images },
    },
    storage: { signedUrl: vi.fn(async (b: string, k: string) => `https://s/${b}/${k}`) },
    thumbnailBucket: 'thumbs',
    imagesEnabled: true,
    ...over,
  } as unknown as MediaDeps & { storage: AssetStorage };
  return { deps, renders, uploads, images };
}

describe('media cursor', () => {
  it('round-trips and rejects anything else', () => {
    const raw = encodeMediaCursor({ at: T, id: 'abc' });
    expect(decodeMediaCursor(raw)).toEqual({ at: T, id: 'abc' });
    for (const bad of ['', 'nope', Buffer.from('{"t":"x","id":"a"}').toString('base64url')])
      expect(() => decodeMediaCursor(bad)).toThrow(ValidationError);
  });
});

describe('listMedia', () => {
  it('breaks createdAt ties by id descending and shapes each type', async () => {
    const { deps } = fakeDeps();
    const result = await listMedia(deps, 'org', listMediaQuery.parse({}));
    expect(result.data.map((i) => i.id)).toEqual(['u_c', 'r_b']);
    expect(result.data[0]).toMatchObject({
      type: 'upload',
      kind: 'demo_video',
      sizeBytes: 42,
      previewUrl: 'https://s/b/k',
    });
    expect(result.data[1]).toMatchObject({ type: 'video', width: 1080, height: 1920 });
    expect(result.nextCursor).toBeNull();
  });

  it('only queries the requested source, and images only when enabled', async () => {
    const off = fakeDeps({ imagesEnabled: false });
    await listMedia(off.deps, 'org', listMediaQuery.parse({ type: 'image' }));
    expect(off.images).not.toHaveBeenCalled();
    expect(off.renders).not.toHaveBeenCalled();
    const on = fakeDeps();
    await listMedia(on.deps, 'org', listMediaQuery.parse({ type: 'upload' }));
    expect(on.uploads).toHaveBeenCalledOnce();
    expect(on.renders).not.toHaveBeenCalled();
    expect(on.images).not.toHaveBeenCalled();
  });

  it('returns a cursor when a source has more than a page', async () => {
    const { deps } = fakeDeps();
    const page = await listMedia(deps, 'org', listMediaQuery.parse({ limit: '1' }));
    expect(page.data.map((i) => i.id)).toEqual(['u_c']);
    expect(page.nextCursor && decodeMediaCursor(page.nextCursor)).toEqual({ at: T, id: 'u_c' });
  });
});
