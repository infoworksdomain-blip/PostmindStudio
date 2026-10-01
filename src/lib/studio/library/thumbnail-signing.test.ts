import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createS3Storage, storageOptionsFor } from '../storage';
import { createStorageS3Client, R2_MAX_PRESIGN_SEC } from '../storage-client';
import {
  signThumbnail,
  stableSigning,
  THUMB_SIGNING_MARGIN_SEC,
  THUMB_SIGNING_WINDOW_SEC,
  THUMB_URL_TTL_SEC,
  THUMBNAIL_CACHE_CONTROL,
} from './thumbnail-signing';

// BACKLOG 20.15 — stable thumbnail URLs: identical within a signing window (browsers and CDNs
// can cache the image), different across windows, never valid past the R2 / SigV4 7-day cap.

const R2_ENV = {
  STORAGE_PROVIDER: 'r2',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_JURISDICTION: 'eu',
  R2_ACCESS_KEY_ID: 'r2-test-key-id',
  R2_SECRET_ACCESS_KEY: 'r2-test-secret',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_START = Date.UTC(2026, 9, 1); // a window boundary (UTC midnight)

const r2Storage = () => createS3Storage(createStorageS3Client(R2_ENV), storageOptionsFor('r2'));
const s3Storage = () =>
  createS3Storage(
    new S3Client({
      region: 'eu-west-2',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
    }),
    storageOptionsFor('s3'),
  );

describe('stableSigning', () => {
  it('signs as of the window start and stays valid for the window plus the margin', () => {
    const s = stableSigning(WINDOW_START + 5 * 60 * 60 * 1000);
    expect(s.signingDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(s.expiresInSec).toBe(THUMB_SIGNING_WINDOW_SEC + THUMB_SIGNING_MARGIN_SEC);
    expect(THUMB_URL_TTL_SEC).toBe(25 * 60 * 60);
  });

  it('caps the expiry at maxPresignSec (R2 and SigV4: 7 days)', () => {
    expect(THUMB_URL_TTL_SEC).toBeLessThanOrEqual(R2_MAX_PRESIGN_SEC);
    expect(stableSigning(0, 7 * 86_400, 3_600).expiresInSec).toBe(R2_MAX_PRESIGN_SEC);
    expect(stableSigning(0, 3_600, 600, 1_000).expiresInSec).toBe(1_000);
  });

  it('covers every instant of a window: expiry is at least the margin after any request', () => {
    const last = WINDOW_START + DAY_MS - 1;
    const s = stableSigning(last);
    const validUntil = s.signingDate.getTime() + s.expiresInSec * 1000;
    expect(validUntil - last).toBeGreaterThanOrEqual(THUMB_SIGNING_MARGIN_SEC * 1000);
  });
});

describe('signThumbnail with real presigning (R2)', () => {
  it('returns the byte-identical URL within one window', async () => {
    const storage = r2Storage();
    const a = await signThumbnail(storage, 'lib', 'library/abc-thumb.jpg', WINDOW_START + 1_000);
    const b = await signThumbnail(
      storage,
      'lib',
      'library/abc-thumb.jpg',
      WINDOW_START + DAY_MS - 1,
    );
    expect(a).toBe(b);
    const url = new URL(a);
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261001T000000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(THUMB_URL_TTL_SEC));
  });

  it('returns a different URL in the next window', async () => {
    const storage = r2Storage();
    const a = await signThumbnail(storage, 'lib', 'library/abc-thumb.jpg', WINDOW_START + 1_000);
    const b = await signThumbnail(storage, 'lib', 'library/abc-thumb.jpg', WINDOW_START + DAY_MS);
    expect(a).not.toBe(b);
    expect(new URL(b).searchParams.get('X-Amz-Date')).toBe('20261002T000000Z');
  });

  it('works the same on S3', async () => {
    const storage = s3Storage();
    const a = await signThumbnail(storage, 'lib', 'k-thumb.jpg', WINDOW_START + 10);
    const b = await signThumbnail(storage, 'lib', 'k-thumb.jpg', WINDOW_START + 20);
    expect(a).toBe(b);
  });

  it('leaves other callers unchanged: no signingDate = signed now', async () => {
    const storage = r2Storage();
    const date = new URL(await storage.signedUrl('lib', 'k', 600)).searchParams.get('X-Amz-Date');
    expect(date?.slice(0, 8)).toBe(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  });
});

describe('Cache-Control at upload', () => {
  it('put() stores the given Cache-Control and omits it when not given', async () => {
    const client = createStorageS3Client(R2_ENV);
    const send = vi.spyOn(client, 'send').mockResolvedValue({} as never);
    const storage = createS3Storage(client, storageOptionsFor('r2'));
    await storage.put({
      bucket: 'lib',
      key: 'library/h-thumb.jpg',
      body: new Uint8Array([1]),
      contentType: 'image/jpeg',
      cacheControl: THUMBNAIL_CACHE_CONTROL,
    });
    await storage.put({
      bucket: 'lib',
      key: 'library/h.mp4',
      body: new Uint8Array([1]),
      contentType: 'video/mp4',
    });
    const inputs = send.mock.calls.map((c) => (c[0] as PutObjectCommand).input);
    expect(inputs[0]?.CacheControl).toBe('public, max-age=604800, immutable');
    expect(inputs[1]?.CacheControl).toBeUndefined();
  });
});
